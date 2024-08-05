js_sidecar is a Rust crate which, instead of embedding a JS library directly into the application, passes JavaScript
code to a separate, persistent Node.js process for execution.

It's somewhat difficult right now to embed a well-equipped JS engine into your application if you want to have full API
availability, and so this gets around that problem while avoiding the overhead of starting a new process for every
expression evaluation.

## Performance

Some relevant timings from the benchmarks (`cargo bench`), run on an M3 Max Macbook Pro and Node 20.16.

- A simple script execution ("2 + 2") takes a bit under 200us to send the code to Node.js, run it, and return the result.
- A ping-style message from the Rust host to Node.js and back, without running any code, takes about 13us.

## Alternatives

### Embedding Deno

In [my experience in the past](https://github.com/dimfeld/ergo/tree/master/js) this worked out ok, but you have to set
up a lot of runtime stuff yourself. Updating all the Deno crates together was also a pain and there were often breaking
changes to be handled. Some of this might be better now as Deno itself has matured, but overall it seemed that embedding
a "full-featured Deno" is not really easy without copying a bunch of code from the Deno repository itself.

### QuickJS/Boa/etc

The primary issues here are in ecosystem compatibility and API availability, most notably the lack of `fetch`. This may
not be an issue for some applications, but sometimes you need APIs which only really work in JS engines which are
compatible with Node or WinterCG.

As QuickJS gets more WinterCG APIs through the LLRT project, this also may be less of an issue. And Boa, a JS runtime
written in Rust, is in early days but also looks promising.

## Downsides Compared to Embedding

This requires Node.js to be installed on the system, which can complicate distribution and may make this a non-starter
for certain use cases. In the future I may look into embedding the Bun executable directly, to allow self-contained
usage when desired.

The primary downside is that every communication needs to go through a Unix socket, which lowers performance somewhat.
This won't be an issue for most cases, especially since zero-copy isn't really possible going into an embedded JS engine
anyway, but is worth considering.

Cases that use a lot of callbacks from the script into the Rust host will see the largest performance degradation. (This
also isn't supported yet with this crate but is planned for the future.) 
