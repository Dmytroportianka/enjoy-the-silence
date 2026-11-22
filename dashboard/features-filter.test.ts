import { describe, expect, test } from "bun:test";
import {
  countByProject,
  countByState,
  filterWorkOrders,
  hasActiveWorkOrderFilters,
  type WorkOrderLike,
} from "./src/features-filter";

const orders: WorkOrderLike[] = [
  {
    id: "t-1",
    title: "Add candle checkout",
    prompt: "Stripe payments for the shop",
    state: "running",
    taskType: "feature",
    tags: [
      "payments",
    ],
    projectId: "shop",
    lane: "fast",
  },
  {
    id: "t-2",
    title: "Fix login redirect",
    prompt: "OAuth loop on Safari",
    state: "done",
    taskType: "bug",
    tags: [
      "auth",
    ],
    projectId: "shop",
  },
  {
    id: "t-3",
    title: "Nightly report",
    prompt: "Summarise factory activity",
    state: "planned",
    taskType: "feature",
    tags: [],
    projectId: "factory",
  },
];
const projectName = (id: string) => (id === "shop" ? "Candle Shop" : "Factory");

describe("filterWorkOrders", () => {
  test("matches every query token across title, prompt, tags, project, id and lane", () => {
    expect(
      filterWorkOrders(
        orders,
        {
          query: "candle stripe",
        },
        projectName,
      ).map((t) => t.id),
    ).toEqual([
      "t-1",
    ]);
    expect(
      filterWorkOrders(
        orders,
        {
          query: "PAYMENTS",
        },
        projectName,
      ).map((t) => t.id),
    ).toEqual([
      "t-1",
    ]);
    expect(
      filterWorkOrders(
        orders,
        {
          query: "t-3",
        },
        projectName,
      ).map((t) => t.id),
    ).toEqual([
      "t-3",
    ]);
  });

  test("blank query matches all and project/state filters compose", () => {
    expect(
      filterWorkOrders(
        orders,
        {
          query: "  ",
        },
        projectName,
      ),
    ).toHaveLength(3);
    expect(
      filterWorkOrders(
        orders,
        {
          query: "",
          projectId: "shop",
          state: "done",
        },
        projectName,
      ).map((t) => t.id),
    ).toEqual([
      "t-2",
    ]);
    expect(
      filterWorkOrders(
        orders,
        {
          query: "checkout",
          state: "done",
        },
        projectName,
      ),
    ).toEqual([]);
  });

  test("counts are faceted by project and state", () => {
    expect(countByProject(orders)).toEqual(
      new Map([
        [
          "shop",
          2,
        ],
        [
          "factory",
          1,
        ],
      ]),
    );
    expect(countByState(orders).get("running")).toBe(1);
  });

  test("hasActiveWorkOrderFilters detects any active facet", () => {
    expect(
      hasActiveWorkOrderFilters({
        query: "",
      }),
    ).toBe(false);
    expect(
      hasActiveWorkOrderFilters({
        query: " x ",
      }),
    ).toBe(true);
    expect(
      hasActiveWorkOrderFilters({
        query: "",
        projectId: "shop",
      }),
    ).toBe(true);
    expect(
      hasActiveWorkOrderFilters({
        query: "",
        state: "done",
      }),
    ).toBe(true);
  });
});
