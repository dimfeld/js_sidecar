use criterion::{criterion_group, criterion_main, Criterion};
use js_sidecar::{JsSidecar, RunScriptArgs};

pub fn benchmark(c: &mut Criterion) {
    let mut group = c.benchmark_group("js_sidecar");

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();

    let mut sidecar = runtime.block_on(JsSidecar::new(Some(1))).unwrap();

    group.bench_function("single_connection", |b| {
        b.to_async(&runtime).iter_with_large_drop(|| async {
            let mut conn = sidecar.connect().await.unwrap();
            conn.run_script_and_wait(RunScriptArgs {
                code: "2 + 2".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        })
    });

    runtime.block_on(sidecar.close());

    group.finish();
}

criterion_group!(benches, benchmark);
criterion_main!(benches);
