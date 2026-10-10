/**
 * `GET /demo/enter` — the live demo's front door. Next.js needs the route
 * file here; the handler is the cloud's (`cloud/demo/enter.ts`) and 404s
 * unless `DEMO_MODE` is set.
 */
export { GET } from "@/cloud/demo/enter";
