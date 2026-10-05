/** Minimal typing for Electron utilityProcess child parentPort. */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

declare namespace NodeJS {
  interface Process {
    parentPort?: ParentPort;
  }
}
