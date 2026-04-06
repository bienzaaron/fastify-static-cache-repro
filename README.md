# `@fastify/static` `preCompressed` fallback drops per-request cache settings

## Summary

When `@fastify/static` is registered with [`preCompressed: true`](./server.ts#L16-L21), a route-level `reply.sendFile()` call can lose its per-request cache settings if the requested precompressed asset does not exist.

This repo reproduces that with two otherwise equivalent HTML routes:

- [`/index.html`](./server.ts#L35-L42) works because [`public/index.html.gz`](./public/index.html.gz) exists.
- [`/no-precompressed.html`](./server.ts#L23-L33) fails because there is no `public/no-precompressed.html.gz` fallback asset.

Both routes explicitly set `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0`, but only the route without a matching precompressed file is overwritten back to the plugin default `public, max-age=2592000`.

## Root Cause

The bug is in `@fastify/static`'s precompressed retry path.

In [`pumpSendToReply()`](https://github.com/fastify/fastify-static/blob/v9.0.0/index.js#L188-L387), the first attempt is made with merged per-request options:

- `const options = Object.assign({}, sendOptions, pumpOptions)` at [`index.js#L198`](https://github.com/fastify/fastify-static/blob/v9.0.0/index.js#L198)

When the precompressed file is missing, `@fastify/static` retries with the original pathname, but it does so with `pumpOptions` set to `undefined`:

- retry call at [`index.js#L342-L352`](https://github.com/fastify/fastify-static/blob/v9.0.0/index.js#L342-L352)

That means route-level `sendFile(..., { maxAge: 0, cacheControl: false })` options are discarded during fallback, and the retry uses the plugin-level defaults from registration instead:

- plugin defaults in [`server.ts#L16-L21`](./server.ts#L16-L21)

Once the fallback succeeds, `reply.headers(headers)` applies headers produced from the wrong options:

- header application at [`index.js#L371-L384`](https://github.com/fastify/fastify-static/blob/v9.0.0/index.js#L371-L384)

So the failure mode is:

1. Route sets `cache-control` explicitly and calls `sendFile(..., { maxAge: 0, cacheControl: false })`.
2. `preCompressed` tries `*.gz` first.
3. The compressed file is missing.
4. The retry drops `pumpOptions`.
5. The successful fallback response regenerates cache headers from plugin defaults and overwrites the route header.

## Reproduction Steps

1. Install dependencies:

```bash
pnpm install
```

2. Run the repro:

```bash
node server.ts
```

3. Observe the printed output.

Expected behavior in this repo:

- [`/index.html`](./server.ts#L35-L42) should return `no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0`
- [`/no-precompressed.html`](./server.ts#L23-L33) should also return `no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0`
- [`/style.css`](./public/style.css) should return the plugin default cache header

## Expected Result

```text
Server:   http://[::1]:60782

Request: http://[::1]:60782/index.html
Expected: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0
Actual:   no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0

Request: http://[::1]:60782/no-precompressed.html
Expected: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0
Actual:   no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0

Request: http://[::1]:60782/style.css
Expected: public, max-age=2592000
Actual:   public, max-age=2592000
```

## Actual Result

```text
Server:   http://[::1]:60782

Request: http://[::1]:60782/index.html
Expected: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0
Actual:   no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0

Request: http://[::1]:60782/no-precompressed.html
Expected: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0
Actual:   public, max-age=2592000

Request: http://[::1]:60782/style.css
Expected: public, max-age=2592000
Actual:   public, max-age=2592000
```

## Suggested Fix Diff

Minimal fix: preserve `pumpOptions` when retrying the uncompressed path after a missing precompressed asset.

```diff
diff --git a/index.js b/index.js
@@
           if (opts.preCompressed && !checkedEncodings.has(encoding)) {
             checkedEncodings.add(encoding)
             return pumpSendToReply(
               request,
               reply,
               pathnameOrig,
               rootPath,
               rootPathOffset,
-              undefined,
+              pumpOptions,
               checkedEncodings
             )
           }
```

That keeps per-request `sendFile()` behavior intact while still allowing the precompressed lookup to fall back to the original file.
