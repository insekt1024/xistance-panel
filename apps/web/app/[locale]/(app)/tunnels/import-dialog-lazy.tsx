"use client";

import dynamic from "next/dynamic";
import type { ImportNode } from "./import-dialog";

const ImportDialogInner = dynamic(
  () => import("./import-dialog").then((m) => ({ default: m.ImportDialog })),
  { ssr: false },
);

export function ImportDialogLazy({ nodes }: { nodes: ImportNode[] }) {
  return <ImportDialogInner nodes={nodes} />;
}
