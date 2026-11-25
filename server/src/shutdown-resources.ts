export type ShutdownResource = {
  kind: string;
  /** 这一份运行自己的编号，从登记到注销不变、同一 kind 下不复用：重启确认按 `kind:id` 比「多出了谁」。 */
  id: string;
  label: string;
  projectId?: string;
  pid?: number;
  ports?: number[];
};

type Cleanup = {
  resources: () => ShutdownResource[] | Promise<ShutdownResource[]>;
  exit: () => void;
};

const cleanups = new Set<Cleanup>();

export function registerShutdownCleanup(resources: Cleanup["resources"], exit: Cleanup["exit"]): () => void {
  const cleanup = { resources, exit };
  cleanups.add(cleanup);
  process.once("exit", exit);
  return () => {
    cleanups.delete(cleanup);
    process.removeListener("exit", exit);
  };
}

export async function shutdownResources(): Promise<{ version: 1; resources: ShutdownResource[] }> {
  const resources = [];
  for (const cleanup of cleanups) resources.push(...await cleanup.resources());
  return { version: 1, resources };
}
