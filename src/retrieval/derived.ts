import { redactText } from "../capture/redact";
import { hashTuple } from "../hash";
import type { DerivedDocument } from "./contract";

export interface CanonicalDocumentSource {
  projectID: string;
  noteID: string;
  revision: number;
  kind: string;
  title: string;
  summary: string;
  content: string;
}

export function deriveDocument(source: CanonicalDocumentSource): DerivedDocument | undefined {
  const title = redactText(source.title);
  const summary = redactText(source.summary);
  const content = redactText(source.content);
  const contentHash = hashTuple("derived-note", 2, [source.kind, title.text, summary.text, content.text]);
  return {
    projectID: source.projectID,
    noteID: source.noteID,
    revision: source.revision,
    kind: source.kind,
    title: title.text,
    summary: summary.text,
    content: content.text,
    contentHash,
  };
}
