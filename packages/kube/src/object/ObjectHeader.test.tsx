import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Gvr } from "@twigo/protocol";
import { withScreenSize } from "../../test/workbench";
import { ObjectHeader } from "./ObjectHeader";

const size = withScreenSize(1000);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PODS: Gvr = { group: "", version: "v1", resource: "pods" };
const POD = "auth-billing-1jt600n-udqzo";
const OWNER = "payments-checkout-controller";
const NAMESPACE = "payments-production-eu";
const NODE = "ip-10-0-12-34.eu-west-1.compute.internal";

function drawn(
  props: {
    name?: string;
    node?: string;
    owner?: string;
    space?: { name: string; color: undefined };
    outside?: HTMLElement;
  } = {},
) {
  const { name = POD, node = NODE, owner = OWNER, space, outside } = props;
  const now = Date.parse("2026-11-18T12:00:00Z");
  vi.useFakeTimers({ now, toFake: ["Date"] });
  let object = "k8s://prod-eu//v1/pods/payments/auth-billing";
  let created = now - 32 * 24 * 3600 * 1000;
  const ui = () => (
    <div style={{ fontSize: "12px" }}>
      <ObjectHeader
        object={object}
        gvr={PODS}
        kind="Pod"
        name={name}
        generated={name === POD ? 13 : null}
        controls={<button type="button">Copy Name</button>}
        {...(space && { space })}
        namespace={NAMESPACE}
        owner={{
          target: {
            group: "apps",
            version: "v1",
            kind: "Deployment",
            namespace: NAMESPACE,
            name: owner,
          },
          gvr: undefined,
        }}
        node={node}
        created={new Date(created).toISOString()}
        verdict={undefined}
        sentence={[]}
        verdictLine={false}
        onOpen={() => undefined}
        actions={null}
      />
    </div>
  );
  const { container, rerender } = render(
    ui(),
    outside && { container: outside },
  );
  const header = container.querySelector("header");
  const [title, place] = [...(header?.children ?? [])] as (
    HTMLElement | undefined
  )[];
  const h2 = title?.querySelector<HTMLElement>("h2");
  const titleCopies = title?.querySelector(":scope > [inert]");
  const placeCopies = place?.querySelector(":scope > [inert]");
  if (!title || !place || !h2 || !titleCopies || !placeCopies)
    throw new Error("the header is not drawn");
  const set = (
    room: Element,
    copies: Element,
    needs: readonly number[],
    width: number,
  ) => {
    needs.forEach((need, stage) => {
      const copy = copies.children[stage];
      if (copy) size.resize(copy, need);
    });
    size.resize(room, width);
  };
  return {
    h2,
    place,
    titleCopies,
    placeCopies,
    draw: () => {
      rerender(ui());
    },
    another: () => {
      object += "-next";
      rerender(ui());
    },
    recreated: () => {
      created += 1000;
      rerender(ui());
    },
    ageing: (ms: number) => {
      vi.setSystemTime(created + ms);
      rerender(ui());
    },
    laidOut: (bases: readonly number[], width: number) => {
      bases.forEach((base, stage) => {
        const copy = placeCopies.children[stage];
        if (!copy) return;
        const reserved = copy.querySelector("[data-widest]");
        const shown = copy.lastElementChild?.textContent ?? "";
        size.resize(
          copy,
          base +
            7 *
              Math.max(
                shown.length,
                reserved?.getAttribute("data-widest")?.length ?? 0,
              ),
        );
      });
      size.resize(place, width);
    },
    named: () => h2.lastElementChild as HTMLElement,
    parts: () =>
      [...place.children].filter((part) => !part.hasAttribute("inert")),
    title: (needs: readonly number[], width: number) => {
      set(h2, titleCopies, needs, width);
    },
    where: (needs: readonly number[], width: number) => {
      set(place, placeCopies, needs, width);
    },
  };
}

const TITLE = [237, 195, 167, 134];
const WHERE = [450, 400, 350, 300, 200, 150];

const pieces = (element: Element | null | undefined) =>
  [...(element?.firstElementChild?.children ?? [])].map(
    (piece) => piece.textContent,
  );

test("the first line keeps the kind word and the whole name while they fit, then the name gives up its generated part", () => {
  const header = drawn();
  header.title(TITLE, 300);
  expect(header.h2.dataset.stage).toBe("0");
  expect(within(header.h2).getByText("Pod")).toBeTruthy();
  expect(header.named().textContent).toBe(POD);
  expect(header.named().title).toBe("");

  header.title(TITLE, 220);
  expect(header.h2.dataset.stage).toBe("1");
  expect(within(header.h2).getByText("Pod")).toBeTruthy();
  expect(header.named().title).toBe(POD);
});

test("the kind word leaves before the name is cut in the middle, its icon keeping the kind in its tooltip alone, and the name's tooltip saying both", () => {
  const header = drawn();
  header.title(TITLE, 300);
  expect(screen.queryByTitle("Pod")).toBeNull();

  header.title(TITLE, 190);
  expect(header.h2.dataset.stage).toBe("2");
  expect(within(header.h2).queryByText("Pod")).toBeNull();
  expect(screen.getByTitle("Pod").getAttribute("aria-hidden")).toBe("true");
  expect(screen.queryByRole("img")).toBeNull();
  expect(header.named().title).toBe(`Pod ${POD}`);
  expect(header.named().textContent).toBe(POD);

  header.title(TITLE, 150);
  expect(header.h2.dataset.stage).toBe("3");
  expect(pieces(header.named())).toEqual([
    "auth-bi",
    "lling-1jt600n-",
    "udqzo",
  ]);
  expect(header.named().title).toBe(`Pod ${POD}`);
});

test("the first line comes back to a fuller stage only with 16 px to spare", () => {
  const header = drawn();
  header.title(TITLE, 150);
  expect(header.h2.dataset.stage).toBe("3");
  header.title(TITLE, 167 + 1 + 15);
  expect(header.h2.dataset.stage).toBe("3");
  header.title(TITLE, 167 + 1 + 16);
  expect(header.h2.dataset.stage).toBe("2");
});

test("the second line has every part whole while they fit, then the node, the owner's name, the owner's kind word, the node and the namespace give way in turn", () => {
  const header = drawn();
  const owner = () =>
    screen.getByRole("button", { name: `Deployment ${OWNER}` });
  const dots = () =>
    header.parts().filter((part) => part.textContent === "·").length;

  header.where(WHERE, 500);
  expect(header.place.dataset.stage).toBe("0");
  expect(dots()).toBe(3);
  expect(within(owner()).getByText("Deployment")).toBeTruthy();
  expect(screen.getByRole("button", { name: `Node ${NODE}` })).toBeTruthy();
  expect(header.place.title).toBe("");

  header.where(WHERE, 420);
  expect(header.place.dataset.stage).toBe("1");
  header.where(WHERE, 360);
  expect(header.place.dataset.stage).toBe("2");
  expect(within(owner()).getByText("Deployment")).toBeTruthy();

  header.where(WHERE, 320);
  expect(header.place.dataset.stage).toBe("3");
  expect(within(owner()).queryByText("Deployment")).toBeNull();
  expect(owner().title).toBe(`Deployment ${OWNER}`);
  expect(dots()).toBe(3);

  header.where(WHERE, 220);
  expect(header.place.dataset.stage).toBe("4");
  expect(screen.queryByRole("button", { name: /^Node / })).toBeNull();
  expect(dots()).toBe(2);
  expect(header.place.title).toBe(
    `${NAMESPACE} · Deployment ${OWNER} · Node ${NODE}`,
  );
  expect(header.parts().pop()?.textContent).toBe("32d");

  header.where(WHERE, 160);
  expect(header.place.dataset.stage).toBe("5");
  expect(pieces(header.parts()[0])).toEqual(["payments-p", "roduction-", "eu"]);
  expect(header.parts().pop()?.textContent).toBe("32d");
});

test("the second line comes back to a fuller stage only with 16 px to spare", () => {
  const header = drawn();
  header.where(WHERE, 220);
  expect(header.place.dataset.stage).toBe("4");
  header.where(WHERE, 300 + 1 + 15);
  expect(header.place.dataset.stage).toBe("4");
  header.where(WHERE, 300 + 1 + 16);
  expect(header.place.dataset.stage).toBe("3");
});

test("the full page leads the second line with the space's name, then the namespace after a chevron, and the stages leave the space whole", () => {
  const header = drawn({ space: { name: "prod-eu", color: undefined } });
  header.where(WHERE, 160);
  const [space] = header.parts();
  expect(space?.textContent).toBe("prod-eu");
  expect(
    header.parts().filter((part) => part.textContent === "·"),
  ).toHaveLength(1);
});

test("a stage's copy draws a name that a cut cannot shorten as one piece, and one it can as head, middle and tail", () => {
  const uncut = drawn({ node: "prod-eu-node-29" });
  const cut = drawn();
  const whole = (header: { placeCopies: Element }, text: string) =>
    [...(header.placeCopies.children[1]?.querySelectorAll("*") ?? [])].find(
      (element) =>
        element.textContent === text && element.children.length === 0,
    );
  expect(whole(uncut, "prod-eu-node-29")).toBeDefined();
  expect(whole(cut, NODE)).toBeUndefined();
});

const FIRST_LINE = ["title", TITLE.length] as const;
const SECOND_LINE = ["where", WHERE.length] as const;

test.each([
  ...Array.from(
    { length: FIRST_LINE[1] },
    (_, prior) => [FIRST_LINE[0], FIRST_LINE[1], prior] as const,
  ),
  ...Array.from(
    { length: SECOND_LINE[1] },
    (_, prior) => [SECOND_LINE[0], SECOND_LINE[1], prior] as const,
  ),
])(
  "another object in the %s line takes the fullest stage that fits its widths in the same room, whatever stage it had (%s stages, from %s)",
  (line, stages, prior) => {
    const header = drawn();
    const set = line === "title" ? header.title : header.where;
    const stage = () =>
      (line === "title" ? header.h2 : header.place).dataset.stage;
    const fitting = (first: number, fits: number) =>
      Array.from({ length: stages }, (_, index) =>
        index < first ? 200 : index === first ? fits : 100,
      );
    set(fitting(prior, 100), 150);
    expect(stage()).toBe(String(prior));
    set(fitting(2, 140), 150);
    header.another();
    expect(stage()).toBe("2");
  },
);

test.each([
  ["title", "another"],
  ["where", "another"],
  ["title", "recreated"],
  ["where", "recreated"],
] as const)(
  "a %s line on a boundary keeps its stage as a copy comes out another width, as for a change of room, and takes the fullest stage that fits once its object is %s, though the widths are the same",
  (line, change) => {
    const header = drawn();
    const set = line === "title" ? header.title : header.where;
    const stage = () =>
      (line === "title" ? header.h2 : header.place).dataset.stage;
    const widths = (second: number, third: number) =>
      (line === "title" ? TITLE : WHERE).map((_, index) =>
        index === 0 ? 200 : index === 1 ? second : index === 2 ? third : 100,
      );
    set(widths(200, 140), 150);
    expect(stage()).toBe("2");
    set(widths(145, 140), 150);
    expect(stage()).toBe("2");
    set(widths(200, 140), 150);
    expect(stage()).toBe("2");
    set(widths(145, 140), 150);
    header.draw();
    expect(stage()).toBe("2");
    header[change]();
    expect(stage()).toBe("1");
  },
);

test("a second line on a boundary keeps its stage while its age goes 2m59s, 3m, 3m10s, 4m, as each text takes the room of the widest age of its range", () => {
  const MINUTE = 60 * 1000;
  const header = drawn();
  const stages = [] as (string | undefined)[];
  for (const age of [
    2 * MINUTE + 59_000,
    3 * MINUTE,
    3 * MINUTE + 10_000,
    4 * MINUTE,
  ]) {
    header.ageing(age);
    header.laidOut(WHERE, 385);
    stages.push(header.place.dataset.stage);
  }
  expect(stages).toEqual(["3", "3", "3", "3"]);
  header.ageing(10 * MINUTE);
  header.laidOut(WHERE, 385);
  expect(header.place.dataset.stage).toBe("3");
});

test("a copy that comes out wider than the line has room for takes it to the next stage at once, the margin holding only a stage back", () => {
  const header = drawn();
  header.title([200, 200, 140, 100], 150);
  expect(header.h2.dataset.stage).toBe("2");
  header.title([200, 200, 155, 100], 150);
  expect(header.h2.dataset.stage).toBe("3");
  header.title([200, 200, 140, 100], 150);
  expect(header.h2.dataset.stage).toBe("3");
  header.title([200, 200, 140, 100], 140 + 1 + 16);
  expect(header.h2.dataset.stage).toBe("2");
});

test("a copy whose cut has no font yet is not read, so the line is never pushed narrower by a name that its cut then shortens, and is read once the font is", async () => {
  const outside = document.createElement("div");
  const header = drawn({ outside });
  header.title(TITLE, 150);
  header.where(WHERE, 160);
  expect(header.h2.dataset.stage).toBe("0");
  expect(header.place.dataset.stage).toBe("0");
  document.body.append(outside);
  act(() => {
    header.draw();
  });
  await act(() => Promise.resolve());
  expect(header.h2.dataset.stage).toBe("3");
  expect(header.place.dataset.stage).toBe("5");
});

test("the heading is named by the kind and the whole name at every stage, and the namespace's cut is read whole", () => {
  const header = drawn();
  const heading = () => screen.getByRole("heading", { name: `Pod ${POD}` });
  for (const [room, stage] of [
    [300, "0"],
    [220, "1"],
    [190, "2"],
    [150, "3"],
  ] as const) {
    header.title(TITLE, room);
    expect(header.h2.dataset.stage).toBe(stage);
    expect(heading()).toBe(header.h2);
  }
  header.where(WHERE, 160);
  const [namespace] = header.parts();
  expect(namespace?.firstElementChild?.getAttribute("aria-hidden")).toBe(
    "true",
  );
  expect(
    within(namespace as HTMLElement).getByText(NAMESPACE).className,
  ).toContain("sr-only");
  header.where(WHERE, 500);
  expect(header.parts()[0]?.textContent).toBe(NAMESPACE);
});

test("the hidden copies hold nothing a person could reach", () => {
  const header = drawn();
  for (const copies of [header.titleCopies, header.placeCopies]) {
    expect(copies.getAttribute("aria-hidden")).toBe("true");
    expect(copies.querySelector("button, a")).toBeNull();
  }
});
