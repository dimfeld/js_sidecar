use criterion::{criterion_group, criterion_main, Criterion};
use futures::FutureExt;
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

    group.bench_function("only_execution", |b| {
        b.to_async(&runtime).iter_custom(|iters| {
            sidecar.connect().then(move |conn| async move {
                let mut conn = conn.unwrap();
                let now = std::time::Instant::now();
                for _ in 0..iters {
                    conn.run_script_and_wait(RunScriptArgs {
                        code: "2 + 2".into(),
                        recreate_context: true,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                }
                now.elapsed()
            })
        })
    });

    group.bench_function("connection_recycle_overhead", |b| {
        b.to_async(&runtime).iter_with_large_drop(|| async {
            let _ = sidecar.connect().await.unwrap();
        })
    });

    group.bench_function("ping", |b| {
        b.to_async(&runtime).iter_custom(|iters| {
            sidecar.connect().then(move |conn| async move {
                let mut conn = conn.unwrap();
                let now = std::time::Instant::now();
                for _ in 0..iters {
                    conn.ping().await.ok();
                    conn.receive_message().await.unwrap();
                }
                now.elapsed()
            })
        })
    });

    runtime.block_on(sidecar.close());

    group.finish();
}

criterion_group!(benches, benchmark);
criterion_main!(benches);
