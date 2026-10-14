declare module "*.py" {
  const source: string;
  export default source;
}

/** A file embedded in the compiled binary (`with { type: "file" }`): evaluates to a path fs can read. */
declare module "*.wasm" {
  const path: string;
  export default path;
}
