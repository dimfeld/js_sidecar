This is a Rust library which, instead of embedding a JS library directly into the application,
communicates with a persistent pool of Node.js processes that are set up to execute code.

It's somewhat difficult right now to embed a well-equipped JS engine instance into your application
if you want to have full API availability, and so this gets around that problem while avoiding the
overhead of starting a new process for every expression evaluation.

## Alternatives

### Embedding Deno

In [my experience in the past](https://github.com/dimfeld/ergo/tree/master/js) this worked out ok, but you have to set up a lot of runtime stuff yourself.
Updating all the Deno crates together was also a pain and there were often breaking changes to be handled.
Some of this might be better now as Deno itself has matured, but overall it seemed that embedding a "full-featured Deno" is not really as easy as it could be.

### QuickJS/Boa/etc

Primarily, runtime compatibility. Some applications may need to do things that only really work in the most popular JS engines, which are compatible with Node.js or WinterCG.
It's also harder to include arbitrary NPM packages or similar, without bundling. As QuickJS gets more WinterCG compatibility this also may be less of an issue.

## Downsides Compared to Embedding

The primary downside is that every communication needs to go through a
Unix socket, which lowers performance somewhat. This won't be an issue for most cases,
especially since zero-copy isn't really possible going into an embedded JS engine anyway, but is
worth considering.

Cases that use a lot of callbacks from the script into the Rust host will see the largest
performance degradation. (This also isn't supported yet with this crate but is planned for the
future.)

