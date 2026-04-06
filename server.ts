import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

/**
 * Reproduction: custom cache control headers are discarded when `preCompressed`
 * is set to true, but no pre-compressed asset exists in the static directory.
 *
 * node server.ts
 *
 */

const app = Fastify({ logger: false });
const root = path.join(import.meta.dirname, "public");

app.register(fastifyStatic, {
  root,
  prefix: "/",
  preCompressed: true,
  maxAge: 2592000000, // 30 days
});

app.get("/no-precompressed.html", async (request, reply) => {
  return reply
    .header(
      "cache-control",
      "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
    )
    .sendFile("no-precompressed.html", root, {
      maxAge: 0,
      cacheControl: false,
    });
});

app.get("/index.html", async (request, reply) => {
  return reply
    .header(
      "cache-control",
      "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
    )
    .sendFile("index.html", "/", { maxAge: 0, cacheControl: false });
});

const addr = await app.listen({ port: 0 });

console.log(`\nServer:   ${addr}`);

const urls = [
  `${addr}/index.html`,
  `${addr}/no-precompressed.html`,
  `${addr}/style.css`,
];

for (const url of urls) {
  const res = await fetch(url);
  const cc = res.headers.get("cache-control");

  console.log(`\nRequest: ${url}`);
  console.log(
    url.endsWith("html")
      ? `Expected: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0`
      : `Expected: public, max-age=2592000`
  );
  console.log(`Actual:   ${cc}`);
}

console.log(`\ncopy-paste shell commands to see resulting header:`);
for (const url of urls) {
  console.log(
    `node -e "fetch('${url}').then((r) => console.log(r.headers.get('cache-control')))"`
  );
}

await app.close();
