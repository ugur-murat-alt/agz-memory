import { createHash } from "crypto";
import { redactText } from "../capture/redact";
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
  if (title.quarantined || summary.quarantined || content.quarantined) return undefined;
  const contentHash = createHash("sha256")
    .update(`${source.kind}\0${title.text}\0${summary.text}\0${content.text}`, "utf8")
    .digest("hex");
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
