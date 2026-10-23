import type { DescribeFrame, DescribeNode, DescribeSource } from "./contract";

// Token-efficient text rendering of an already-pruned DescribeNode tree: the
// per-platform adapters (and the Android v2 trimmer in uiautomator-parser) do
// the pruning, this layer only formats.
//
// Render mode comes from `source`, not the tree silhouette — a single
// accidental grandchild used to flip an ax-service response into nested mode,
// which broke callers diffing two close-in-time describes.

const CONTENT_ROLES = new Set([
  // The roles mapNativeTraitsToDescribeRole can return. AXGroup is excluded on
  // purpose: as its catch-all fallback, requiring it to carry its own
  // label/value before we emit a line keeps decorative groupings out.
  "AXButton",
  "AXStaticText",
  "AXImage",
  "AXLink",
  "AXTextField",
  "AXHeading",
  "AXTabBar",
  "AXAdjustable",
]);

// Vega UIToolkit roles: the toolkit emits these as undecorated leaves, which
// the nested renderer's content gate would otherwise drop. Kept separate from
// CONTENT_ROLES because the same lowercase roles occur on Chromium (an SVG
// `<text>`/`<image>`, `role="image"`), where counting them as content would
// print lines that are pruned today.
const VEGA_CONTENT_ROLES = new Set([...CONTENT_ROLES, "button", "text", "image"]);

function clampFinite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function fmtFrame(f: DescribeFrame): string {
  return `(${clampFinite(f.x).toFixed(3)}, ${clampFinite(f.y).toFixed(3)}, ${clampFinite(
    f.width
  ).toFixed(3)}, ${clampFinite(f.height).toFixed(3)})`;
}

function escapeForLine(s: string): string {
  // Escape rather than strip: a raw newline/tab breaks the one-line-per-node
  // shape callers grep, and escaping keeps the original character recoverable.
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

function formatLabel(label: string | undefined): string {
  if (!label) return "";
  return `"${escapeForLine(label)}"`;
}

function formatAttr(name: string, value: string | undefined): string {
  if (!value) return "";
  return ` ${name}="${escapeForLine(value)}"`;
}

function formatFlags(n: DescribeNode): string {
  const flags: string[] = [];
  if (n.clickable) flags.push("clickable");
  if (n.longClickable) flags.push("long-clickable");
  if (n.scrollable) flags.push("scrollable");
  // The Chromium walker reports `checked` without `checkable`, so the state
  // flag cannot be gated on the pair.
  if (n.checked) flags.push("checked");
  else if (n.checkable) flags.push("checkable");
  if (n.focused) flags.push("focused");
  if (n.selected) flags.push("selected");
  if (n.disabled) flags.push("disabled");
  if (n.password) flags.push("password");
  if (typeof n.scrollHidden === "number" && n.scrollHidden > 0) {
    flags.push(`scrollHidden=${n.scrollHidden}`);
  }
  return flags.length === 0 ? "" : ` [${flags.join(",")}]`;
}

function hasContent(n: DescribeNode): boolean {
  return Boolean(
    n.label ||
    n.value ||
    n.identifier ||
    n.clickable ||
    n.longClickable ||
    n.scrollable ||
    n.checkable ||
    n.checked ||
    (typeof n.scrollHidden === "number" && n.scrollHidden > 0)
  );
}

// The role check is what keeps unlabeled `AXImage`s and icon-only `AXButton`s
// in the output — without it, anything missing `accessibilityLabel` on iOS
// would silently vanish from describe.
function shouldEmit(n: DescribeNode, contentRoles: ReadonlySet<string>): boolean {
  return hasContent(n) || contentRoles.has(n.role);
}

function formatLine(n: DescribeNode, indent: number, note?: string): string {
  const pad = "  ".repeat(indent);
  // iOS reports a text input's placeholder as both label and value; printing
  // it twice costs bytes for no signal.
  const dedupedValue = n.value && n.value !== n.label ? n.value : undefined;
  const labelPart = formatLabel(n.label);
  const valuePart = formatAttr("value", dedupedValue);
  const idPart = formatAttr("id", n.identifier);
  const flagPart = formatFlags(n);
  const notePart = note ? ` [${note}]` : "";
  const annotations = `${labelPart}${valuePart}${idPart}${flagPart}${notePart}`.trim();
  const annotated = annotations ? ` ${annotations}` : "";
  return `${pad}${n.role}${annotated}  ${fmtFrame(n.frame)}`;
}

function renderFlat(
  root: DescribeNode,
  contentRoles: ReadonlySet<string>,
  notes: Map<DescribeNode, string>
): string[] {
  return root.children
    .filter((n) => shouldEmit(n, contentRoles))
    .slice()
    .sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x)
    .map((n) => formatLine(n, 1, notes.get(n)));
}

function renderNested(root: DescribeNode, contentRoles: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  // Iterative DFS so very deep Compose / RN trees can't overflow the stack.
  // Start at depth 1: the header already prints the root as its ROOT line.
  type Frame = { node: DescribeNode; depth: number };
  const stack: Frame[] = [];
  for (let i = root.children.length - 1; i >= 0; i--) {
    stack.push({ node: root.children[i]!, depth: 1 });
  }
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (shouldEmit(node, contentRoles) || node.children.length > 0) {
      lines.push(formatLine(node, depth));
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i]!, depth: depth + 1 });
    }
  }
  return lines;
}

interface FormatDescribeOptions {
  source: DescribeSource;
}

const OVERLAP_SKIP_ROLES = new Set(["AXAdjustable"]);
// Text over text is a layout quirk, not a tap trap.
const PASSIVE_ROLES = new Set(["AXStaticText", "AXImage", "AXHeading"]);
// ax-service reports UIKit scroll indicators as labelled AXGroups. They sit
// over the content they scroll, alert button stacks included, and no scroll
// can separate an indicator from its own content.
const SCROLL_INDICATOR_LABEL = /^(vertical|horizontal) scroll bar\b/i;
const OVERLAP_MAX_ELEMENT_AREA = 0.5;
const OVERLAP_MIN_RATIO = 0.25;
const OVERLAP_MAX_RATIO = 0.95;
const OVERLAP_NAME_MAX = 40;
const OVERLAP_PARTNERS_MAX = 3;

interface OverlapPartner {
  other: DescribeNode;
  ratio: number;
}

function frameArea(f: DescribeFrame): number {
  return f.width * f.height;
}

function overlapRatio(a: DescribeFrame, b: DescribeFrame): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  return (width * height) / Math.min(frameArea(a), frameArea(b));
}

function isOverlapCandidate(n: DescribeNode): boolean {
  return (
    Boolean(n.label || n.identifier || n.value) &&
    !OVERLAP_SKIP_ROLES.has(n.role) &&
    !SCROLL_INDICATOR_LABEL.test(n.label ?? "") &&
    n.frame.width > 0 &&
    n.frame.height > 0 &&
    frameArea(n.frame) < OVERLAP_MAX_ELEMENT_AREA
  );
}

function overlapName(n: DescribeNode): string {
  // Cut by code point: a lone surrogate left by a UTF-16 slice makes strict
  // JSON parsers reject the whole MCP message.
  const raw = Array.from(n.label || n.identifier || n.value || n.role)
    .slice(0, OVERLAP_NAME_MAX)
    .join("");
  return `"${escapeForLine(raw).replace(/"/g, "'")}"`;
}

// Partly overlapping elements (a tab bar over a list row) have no stacking
// order in the flat iOS list, so a tap at either centre may hit the other.
function overlapNotes(root: DescribeNode): Map<DescribeNode, string> {
  const candidates = root.children.filter(isOverlapCandidate);
  const partners = new Map<DescribeNode, OverlapPartner[]>();
  const addPartner = (self: DescribeNode, other: DescribeNode, ratio: number) => {
    const list = partners.get(self) ?? [];
    list.push({ other, ratio });
    partners.set(self, list);
  };

  candidates.forEach((a, i) => {
    for (const b of candidates.slice(i + 1)) {
      const ratio = overlapRatio(a.frame, b.frame);
      if (ratio <= OVERLAP_MIN_RATIO || ratio >= OVERLAP_MAX_RATIO) continue;
      if (PASSIVE_ROLES.has(a.role) && PASSIVE_ROLES.has(b.role)) continue;
      addPartner(a, b, ratio);
      addPartner(b, a, ratio);
    }
  });

  const notes = new Map<DescribeNode, string>();
  for (const [self, list] of partners) {
    // Largest overlap first, so separating the named elements clears the worst one.
    const names = list
      .sort((x, y) => y.ratio - x.ratio)
      .slice(0, OVERLAP_PARTNERS_MAX)
      .map((p) => overlapName(p.other))
      .join(", ");
    notes.set(
      self,
      `overlaps ${names}: one covers the other — scroll to separate them before tapping`
    );
  }
  return notes;
}

export function formatDescribeTree(root: DescribeNode, opts: FormatDescribeOptions): string {
  // The iOS providers emit a flat list of leaves under a synthetic root; the
  // sources below return a real parent/child tree, whose descendants beyond
  // depth 1 are only visible in nested mode.
  const mode: "flat" | "nested" =
    opts.source === "uiautomator" ||
    opts.source === "android-devtools" ||
    opts.source === "cdp-dom" ||
    opts.source === "vega-automation" ||
    // Physical iOS: the runner reports a parent/child tree. Nested mode keeps that structure.
    opts.source === "xcuitest-runner"
      ? "nested"
      : "flat";
  const isVega = opts.source === "vega-automation";
  const header: string[] = [];
  header.push(`Source: ${opts.source}`);
  header.push(`Mode: ${mode}`);
  header.push(
    "Coordinates are normalized [0,1] fractions of the screen (x, y, width, height), not pixels."
  );
  if (isVega) {
    header.push(
      "Vega is remote-driven, not touch — there is no tap. Use the frames as spatial hints to plan " +
        "D-pad moves with the `tv-remote` tool: compare the target's frame to the cursor's — the " +
        "`[focused]` element, or `[selected]` when no element reports `[focused]` (the toolkit often " +
        "marks the highlighted item `selected` while `focused` stays false) — " +
        'and count rows/columns to build the path (e.g. one row down and two columns right → ["down","right","right","select"]).'
    );
  } else {
    // Physical iOS has no two-finger gestures. Do not recommend gesture-pinch for this source.
    header.push(
      opts.source === "xcuitest-runner"
        ? "Pass them straight to gesture-tap / gesture-swipe, which expect this same space. " +
            "No two-finger gestures on physical iOS."
        : "Pass them straight to gesture-tap / gesture-swipe / gesture-pinch, which expect this same space."
    );
    header.push(
      "To tap an element, use its centre: tap_x = frame.x + frame.width / 2, tap_y = frame.y + frame.height / 2."
    );
  }
  header.push("");
  header.push(`ROOT  ${root.role} ${fmtFrame(root.frame)}`);
  header.push("");

  // Vega's lowercase toolkit roles count as content only for its own source.
  const contentRoles = isVega ? VEGA_CONTENT_ROLES : CONTENT_ROLES;
  // Overlap notes run on the flat iOS simulator lists only. Nested trees
  // (Android, Chromium, Vega, physical iOS) can have the same sibling overlap,
  // but parent/child frames overlap there by design and the check does not
  // tell the two apart yet.
  const body =
    mode === "flat"
      ? renderFlat(root, contentRoles, overlapNotes(root))
      : renderNested(root, contentRoles);
  return [...header, ...body].join("\n").replace(/\n+$/, "\n");
}
