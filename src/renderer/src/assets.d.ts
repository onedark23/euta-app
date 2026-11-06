// Vite asset imports (resolved to a URL at build time).
declare module '*.svg' {
  const url: string;
  export default url;
}
