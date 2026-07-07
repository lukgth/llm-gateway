// Interactive, collapsible JSON tree with type-based syntax highlighting.
//
// Thin wrapper over react-json-view-lite. We supply our OWN class map (see the
// `jt-*` rules in index.css) so the tree is themed with the app's design tokens
// in both light and dark mode, values sit inline with the tree structure, and
// clicking a row (or its arrow) expands/collapses it.

import { useCallback } from "react";
import { JsonView } from "react-json-view-lite";

// Class map — every key points at one of our own `jt-*` classes so none of the
// library's default styling leaks in.
const style = {
  container: "jt-container",
  childFieldsContainer: "jt-children",
  basicChildStyle: "jt-row",
  label: "jt-label",
  clickableLabel: "jt-label jt-clickable",
  nullValue: "jt-null",
  undefinedValue: "jt-null",
  numberValue: "jt-number",
  stringValue: "jt-string",
  booleanValue: "jt-boolean",
  otherValue: "jt-other",
  punctuation: "jt-punct",
  collapseIcon: "jt-arrow jt-arrow-open",
  expandIcon: "jt-arrow jt-arrow-closed",
  collapsedContent: "jt-collapsed",
  noQuotesForStringValues: false,
  quotesForFieldNames: true,
  stringifyStringValues: false,
} as const;

export function JsonTree({
  json,
  defaultOpenDepth = 2,
}: {
  json: string;
  // Nodes at a depth below this start expanded; deeper ones start collapsed.
  defaultOpenDepth?: number;
}) {
  // Stable identity (the library re-invokes this on every render otherwise).
  const shouldExpand = useCallback(
    (level: number) => level < defaultOpenDepth,
    [defaultOpenDepth],
  );

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    // Captured blobs are always valid JSON, but be defensive: show raw text.
    return (
      <pre className="jt-container whitespace-pre-wrap break-words">{json}</pre>
    );
  }

  return (
    <JsonView
      data={data as object}
      style={style}
      shouldExpandNode={shouldExpand}
      clickToExpandNode
    />
  );
}
