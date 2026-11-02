/** A module worker that Vite bundles from an import with `?worker`. */
declare module "*?worker" {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}

/** A stylesheet that Vite bundles from a side-effect import. */
declare module "*.css";
