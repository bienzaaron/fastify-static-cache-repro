**AI Disclosure**: I have used AI tools to assist in debugging this issue and writing the following description and reproduction. I've fully reviewed the output and am confident in its accuracy.

## Summary

When `@fastify/static` is registered with [`preCompressed: true`](https://github.com/bienzaaron/fastify-static-cache-repro/tree/main/server.ts#L16-L21), a route-level `reply.sendFile()` call can lose its per-request cache settings if the requested precompressed asset does not exist.

This linked reproduction reproduces that with two otherwise equivalent HTML routes:

- [`/index.html`](https://github.com/bienzaaron/fastify-static-cache-repro/tree/main/server.ts#L35-L42) works because [`public/index.html.gz`](https://github.com/bienzaaron/fastify-static-cache-repro/tree/main/public/index.html.gz) exists.
- [`/no-precompressed.html`](https://github.com/bienzaaron/fastify-static-cache-repro/tree/main/server.ts#L23-L33) fails because there is no `public/no-precompressed.html.gz` fallback asset.

Both routes explicitly set `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0`, but only the route without a matching precompressed file is overwritten back to the plugin default `public, max-age=2592000`.

## Reproduction Steps

1. clone repo
```bash
# https
git clone https://github.com/bienzaaron/fastify-static-cache-repro.git
# ssh
git clone git@github.com:bienzaaron/fastify-static-cache-repro.git
```

2. Install dependencies:

```bash
pnpm install
```

2. Run the repro:

```bash
node server.ts
```

3. Observe the printed output.

Expected behavior in this repo:

- [`/index.html`](https://github.com/bienzaaron/fastify-static-cache-repro/tree/main/server.ts#L35-L42) should return `no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0`
- **[`/no-precompressed.html`](https://github.com/bienzaaron/fastify-static-cache-repro/tree/main/server.ts#L23-L33) should also return `no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0`** -- this does not happen
- [`/style.css`](https://github.com/bienzaaron/fastify-static-cache-repro/tree/main/public/style.css) should return the plugin default cache header

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

## Root Cause

The bug is in how `@fastify/static` threads `reply.sendFile(..., options)` through the precompressed fallback path.

When the plugin is registered, it builds a plugin-level `sendOptions` object from registration-time defaults such as `root`, `cacheControl`, and `maxAge`:

- `sendOptions` construction at [`index.js#L43-L55`](https://github.com/fastify/fastify-static/blob/v9.0.0/index.js#L43-L55)
- this repo's plugin defaults at [`server.ts#L16-L21`](https://github.com/bienzaaron/fastify-static-cache-repro/tree/main/server.ts#L16-L21)

Separately, the `reply.sendFile()` decorator accepts per-request overrides and passes them into `pumpSendToReply()` as the `opts` argument, which becomes `pumpOptions`:

- `sendFile` decorator at [`index.js#L84-L95`](https://github.com/fastify/fastify-static/blob/v9.0.0/index.js#L84-L95)
- affected route in this repro at [`server.ts#L23-L33`](https://github.com/bienzaaron/fastify-static-cache-repro/tree/main/server.ts#L23-L33)

So for this call:

```js
reply.sendFile("no-precompressed.html", root, {
  maxAge: 0,
  cacheControl: false,
})
```

`pumpSendToReply()` receives:

- plugin defaults in `sendOptions`
- route-level overrides in `pumpOptions`

On entry, it merges those two objects before calling `@fastify/send`:

- merge at [`index.js#L198`](https://github.com/fastify/fastify-static/blob/v9.0.0/index.js#L198)
- `send()` call at [`index.js#L239-L246`](https://github.com/fastify/fastify-static/blob/v9.0.0/index.js#L239-L246)

```js
const options = Object.assign({}, sendOptions, pumpOptions)
await send(request.raw, encodeURI(pathnameForSend), options)
```

That first call is correct: route-level `pumpOptions` override plugin-level `sendOptions`.

The problem happens only after `preCompressed` tries a compressed asset first and gets `ENOENT`. In that branch, `@fastify/static` retries `pumpSendToReply()` with the original pathname, but passes `undefined` for `pumpOptions`:

- retry at [`index.js#L342-L352`](https://github.com/fastify/fastify-static/blob/v9.0.0/index.js#L342-L352)

```js
return pumpSendToReply(
  request,
  reply,
  pathnameOrig,
  rootPath,
  rootPathOffset,
  undefined,
  checkedEncodings
)
```

At that point, the retry no longer has the original `reply.sendFile(..., options)` overrides. The next merge becomes effectively:

```js
const options = Object.assign({}, sendOptions, undefined)
```

So the second `send()` call uses only plugin registration defaults, not the route-level overrides.

When the fallback succeeds, `reply.headers(headers)` applies the headers generated from that second `send()` call:

- header application at [`index.js#L371-L384`](https://github.com/fastify/fastify-static/blob/v9.0.0/index.js#L371-L384)

That is why this repro behaves differently for these two cases:

1. [`/index.html`](https://github.com/bienzaaron/fastify-static-cache-repro/tree/main/server.ts#L35-L42): `index.html.gz` exists, so the first `send()` call succeeds and keeps the per-request options.
2. [`/no-precompressed.html`](https://github.com/bienzaaron/fastify-static-cache-repro/tree/main/server.ts#L23-L33): `no-precompressed.html.gz` does not exist, so the fallback retry drops `pumpOptions` and reverts to plugin defaults.

So the failure mode is:

1. Route calls `reply.sendFile(..., { maxAge: 0, cacheControl: false })`.
2. `preCompressed` tries `*.gz` first.
3. The compressed file is missing.
4. The retry drops `pumpOptions`.
5. The retry calls `send()` with only `sendOptions`.
6. The fallback response regenerates cache headers from plugin defaults and overwrites the route header.


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

There are also several other recursive `pumpSendToReply` calls occurring with `pumpOptions` set to undefined -- I have not yet done the analysis to see if a similar bug would occur with those callsites. I've only looked at this specific `sendFile` --> `preCompressed` path.
