import { useState } from "react";
import { Button } from "react-aria-components";
import { CodeBody } from "./CodeBody.tsx";
import { buildEditorLink } from "./editorLink.ts";
import type { CodeHighlighter } from "./highlighter.ts";

export interface ExpandableCodeProps {
  label: string;
  text: string;
  language: string;
  privacy: boolean;
  highlighter?: CodeHighlighter;
  /** The absolute file path, for the Open in editor link. */
  path?: string;
  editorTemplate?: string;
  defaultExpanded?: boolean;
}

/** Collapsed by default. The highlighter loads when the first card is expanded, not before. */
export function ExpandableCode({
  label,
  text,
  language,
  privacy,
  highlighter,
  path,
  editorTemplate,
  defaultExpanded = false,
}: ExpandableCodeProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const href =
    path === undefined
      ? null
      : buildEditorLink(path, editorTemplate === undefined ? {} : { template: editorTemplate });
  return (
    <div>
      <Button
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
        onPress={() => setExpanded((on) => !on)}
      >
        {expanded ? "Collapse" : "Expand"}
      </Button>
      {expanded ? (
        <>
          <CodeBody
            text={text}
            language={language}
            privacy={privacy}
            {...(highlighter ? { highlighter } : {})}
          />
          {href ? (
            <a href={href} rel="noopener noreferrer">
              Open in editor
            </a>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
