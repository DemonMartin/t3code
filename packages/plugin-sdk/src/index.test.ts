import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { PluginView, PluginViewDescriptor } from "./index.ts";

const valid = Schema.is(PluginView);
const decodeView = Schema.decodeUnknownSync(PluginView);
it("rejects ambiguous form and table identities before clients render them", () => {
  const form = {
    id: "settings",
    kind: "form",
    label: "Save",
    command: "save",
    input: {},
    fields: [
      { name: "token", label: "Token", kind: "password" },
      { name: "token", label: "Another token", kind: "text" },
    ],
  };
  expect(valid({ title: "Test", blocks: [form] })).toBe(false);
  const collection = {
    id: "items",
    kind: "collection",
    label: "Items",
    items: [{ id: "one", label: "One", search: "", input: { selected: "one" } }],
  };
  expect(valid({ title: "Test", blocks: [collection] })).toBe(true);
  expect(
    valid({
      title: "Test",
      blocks: [{ ...collection, items: [...collection.items, ...collection.items] }],
    }),
  ).toBe(false);
  expect(
    valid({
      title: "Test",
      blocks: [
        { id: "image", kind: "image", label: "Image", source: "https://example.com/tracking.png" },
      ],
    }),
  ).toBe(false);
  const table = {
    id: "accounts",
    kind: "table",
    columns: ["Name"],
    rows: [{ id: "first", cells: ["First"], actions: [] }],
  };
  expect(valid({ title: "Test", blocks: [table] })).toBe(true);
  expect(valid({ title: "Test", blocks: [table, table] })).toBe(false);
  expect(valid({ title: "Test", blocks: [{ ...table, columns: ["Name", "Name"] }] })).toBe(false);
  expect(
    valid({ title: "Test", blocks: [{ ...table, rows: [...table.rows, ...table.rows] }] }),
  ).toBe(false);
  expect(
    valid({
      title: "Test",
      blocks: [{ ...table, rows: [{ id: "first", cells: [], actions: [] }] }],
    }),
  ).toBe(false);
});

it("bounds searchable associations and rejects duplicate identities", () => {
  const item = {
    id: "repo:123",
    label: "#123",
    select: { id: "select", label: "Select", command: "select", input: {} },
  };
  const block = {
    id: "issues",
    kind: "associations",
    label: "Issues",
    selected: [],
    options: [item],
  };
  expect(valid({ title: "Issues", blocks: [block] })).toBe(true);
  expect(valid({ title: "Issues", blocks: [{ ...block, options: [item, item] }] })).toBe(false);
  expect(
    valid({
      title: "Issues",
      blocks: [
        { ...block, selected: Array.from({ length: 21 }, (_, i) => ({ ...item, id: String(i) })) },
      ],
    }),
  ).toBe(false);
});

it("bounds ordered graphs and rejects backwards edges and duplicate nodes", () => {
  const node = {
    id: "child",
    parents: ["parent"],
    label: "Child",
    detail: "Detail",
    annotation: "id",
    badges: [],
    action: { id: "open", label: "Open", command: "read", input: {} },
  };
  const graph = {
    id: "graph",
    kind: "graph",
    label: "History",
    nodes: [node, { ...node, id: "parent", parents: [] }],
  };
  expect(valid({ title: "Test", blocks: [graph] })).toBe(true);
  expect(valid({ title: "Test", blocks: [{ ...graph, nodes: [node, node] }] })).toBe(false);
  expect(valid({ title: "Test", blocks: [{ ...graph, nodes: [...graph.nodes].reverse() }] })).toBe(
    false,
  );
  expect(
    valid({ title: "Test", blocks: [{ ...graph, nodes: [{ ...node, parents: ["child"] }] }] }),
  ).toBe(false);
  expect(
    valid({
      title: "Test",
      blocks: [
        {
          ...graph,
          nodes: Array.from({ length: 101 }, (_, i) => ({ ...node, id: `node-${i}`, parents: [] })),
        },
      ],
    }),
  ).toBe(false);
});

it("carries an optional auto-launch command id on a view descriptor", () => {
  const decode = Schema.decodeUnknownSync(PluginViewDescriptor);
  const launcher = {
    id: "launcher",
    title: "New sandbox",
    location: "environment-launcher",
    permission: "environment:maintain",
  };
  expect(decode({ ...launcher, autoLaunch: "launch" })).toEqual({
    ...launcher,
    autoLaunch: "launch",
  });
  expect(decode(launcher)).toEqual(launcher);
  expect(() => decode({ ...launcher, autoLaunch: "Not An Id" })).toThrow();
});

it("lets a stopped managed environment name the action that starts it again", () => {
  const environment = {
    id: "sandbox",
    kind: "environment",
    environmentId: "sbx-1",
    label: "Sandbox",
    url: "https://sandbox.test",
    state: "stopped",
    connect: { id: "pair", label: "Connect", command: "pair", input: {} },
  };
  const resume = { id: "resume", label: "Resume", command: "state", input: { state: "running" } };
  expect(valid({ title: "Environments", blocks: [environment] })).toBe(true);
  expect(valid({ title: "Environments", blocks: [{ ...environment, resume }] })).toBe(true);
  expect(valid({ title: "Environments", blocks: [{ ...environment, resume: "state" }] })).toBe(
    false,
  );
});

it("lets a status action offer a list whose current value is one of its options", () => {
  const options = [
    { label: "10 min", value: "600" },
    { label: "1 h", value: "3600" },
  ];
  const status = (choice: unknown) => ({
    title: "Thread",
    blocks: [
      {
        id: "state",
        kind: "status",
        label: "Sandbox running",
        actions: [{ id: "idle", label: "Idle stop", command: "idle", input: {}, choice }],
      },
    ],
  });
  const choice = { name: "seconds", value: "600", options };
  expect(decodeView(status(choice)).blocks[0]).toMatchObject({
    actions: [{ choice }],
  });
  expect(valid(status({ ...choice, value: "86400" }))).toBe(false);
  expect(valid(status({ ...choice, options: [...options, options[0]] }))).toBe(false);
  expect(valid(status({ ...choice, name: "Not An Id" }))).toBe(false);
});
