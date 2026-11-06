// The editor's document model (public/pen-core.js + shader.js) run in QuickJS, through js/glue.js. QuickJS values are
// !Send, so one dedicated thread owns the runtime with the modules loaded once (a fresh runtime per call costs ~15 ms);
// calls queue up to it, serialized like they were on Bun's single thread. Strings in, a JSON string out.
use rquickjs::loader::{BuiltinLoader, BuiltinResolver};
use rquickjs::{Context, Ctx, Exception, Function, Module, Object, Runtime, Value};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, mpsc};
use std::time::{SystemTime, UNIX_EPOCH};

const PEN_CORE: &str = include_str!("../../../public/pen-core.js");
const SHADER: &str = include_str!("../../../public/shader.js");
const GLUE: &str = include_str!("../js/glue.js");
// shader.js imports CK (CanvasKit) for program()/shapeSDF(); only toSkSL/parseUniforms/controls run here
const SKIA_STUB: &str = "export const CK = () => { throw new Error('CanvasKit is not available on the server'); };";

pub const TIMEOUT: &str = "Script execution timed out after 5000ms";

pub(crate) enum Fail {
    Timeout,
    Js(String),
}

impl std::fmt::Display for Fail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Fail::Timeout => f.write_str(TIMEOUT),
            Fail::Js(m) => f.write_str(m),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

type Reply = mpsc::Sender<Result<String, Fail>>;
struct Job(&'static str, Vec<Option<String>>, Reply);

static WORKER: LazyLock<mpsc::Sender<Job>> = LazyLock::new(|| {
    let (tx, rx) = mpsc::channel();
    // a big stack: documents are trees and pen-core walks them recursively
    std::thread::Builder::new().name("pena-js".into()).stack_size(64 << 20).spawn(move || worker(rx)).expect("JS thread");
    tx
});

/// Calls an export of glue.js with string (or null) arguments; it returns a string.
pub(crate) fn call(name: &'static str, args: Vec<Option<String>>) -> Result<String, Fail> {
    let (tx, rx) = mpsc::channel();
    let stopped = || Fail::Js("The JavaScript engine stopped".into());
    WORKER.send(Job(name, args, tx)).map_err(|_| stopped())?;
    rx.recv().map_err(|_| stopped())?
}

// glue.js's docOf() throws this when it does not hold the document a key names
const NEED_DOC: &str = "__pena_need_doc__";

/// Calls an export of glue.js whose first arguments are (key, doc, lib). The JS side keeps the last document it parsed
/// under its key (the store's revision), so an unchanged document is neither serialized nor parsed again: on a big
/// file that cost seconds per call. First asked with the key alone; the document is sent only when the JS side lacks
/// it (the worker decides, so concurrent callers cannot race). Without a key the document is sent and not kept.
pub(crate) fn call_doc(name: &'static str, key: Option<u64>, doc: &serde_json::Value, lib: &serde_json::Value, rest: Vec<Option<String>>) -> Result<String, Fail> {
    let args = |d: Option<String>| {
        let l = d.as_ref().and_then(|_| crate::doc::lib_arg(lib));
        [vec![key.map(|k| k.to_string()), d, l], rest.clone()].concat()
    };
    if key.is_some() {
        match call(name, args(None)) {
            Err(Fail::Js(m)) if m == NEED_DOC => {}
            r => return r,
        }
    }
    call(name, args(Some(doc.to_string())))
}

fn worker(jobs: mpsc::Receiver<Job>) {
    let rt = Runtime::new().expect("QuickJS runtime");
    rt.set_max_stack_size(32 << 20);
    rt.set_loader(
        BuiltinResolver::default().with_module("pen-core.js").with_module("shader.js").with_module("skia.js"),
        BuiltinLoader::default().with_module("pen-core.js", PEN_CORE).with_module("shader.js", SHADER).with_module("skia.js", SKIA_STUB),
    );
    // the snippet timeout (node:vm's `timeout`): glue arms it around the snippet only
    let deadline = Arc::new(AtomicU64::new(0));
    let timed_out = Arc::new(AtomicBool::new(false));
    {
        let (deadline, timed_out) = (deadline.clone(), timed_out.clone());
        rt.set_interrupt_handler(Some(Box::new(move || {
            let d = deadline.load(Ordering::Relaxed);
            let stop = d != 0 && now_ms() > d;
            if stop {
                timed_out.store(true, Ordering::Relaxed);
            }
            stop
        })));
    }
    let ctx = Context::full(&rt).expect("QuickJS context");
    ctx.with(|ctx| {
        let glue = (|| -> rquickjs::Result<_> {
            ctx.globals().set("__host", host(&ctx, deadline.clone())?)?;
            let (module, done) = Module::declare(ctx.clone(), "glue.js", GLUE)?.eval()?;
            done.finish::<()>()?;
            Ok(module)
        })()
        .map_err(|e| fail(&ctx, e, false));
        for Job(name, args, reply) in jobs {
            timed_out.store(false, Ordering::Relaxed);
            let r = match &glue {
                Err(Fail::Js(m)) => Err(Fail::Js(m.clone())),
                Err(Fail::Timeout) => unreachable!(),
                Ok(module) => invoke(&ctx, module, name, args).map_err(|e| fail(&ctx, e, timed_out.load(Ordering::Relaxed))),
            };
            // promises a snippet left behind (an async snippet, refused) settle now, on its discarded copy, within the same limit
            deadline.store(now_ms() + 5000, Ordering::Relaxed);
            while ctx.execute_pending_job() && !timed_out.load(Ordering::Relaxed) {}
            deadline.store(0, Ordering::Relaxed);
            let _ = reply.send(r);
            // a call on a big document leaves hundreds of MB of garbage (its JSON, expanded copies): collected now, after
            // the reply, instead of piling up to GBs until QuickJS's own threshold
            ctx.run_gc(); // (Runtime::run_gc here panics: the runtime is borrowed by ctx.with)
        }
    });
}

fn invoke<'js>(ctx: &Ctx<'js>, module: &Module<'js, rquickjs::module::Evaluated>, name: &str, args: Vec<Option<String>>) -> rquickjs::Result<String> {
    let f: Function = module.get(name)?;
    let mut a = rquickjs::function::Args::new(ctx.clone(), args.len());
    for v in args {
        match v {
            Some(s) => a.push_arg(s)?,
            None => a.push_arg(rquickjs::Null)?,
        }
    }
    f.call_arg(a)
}

fn fail(ctx: &Ctx, e: rquickjs::Error, timed_out: bool) -> Fail {
    let thrown = matches!(e, rquickjs::Error::Exception).then(|| ctx.catch()); // also clears it
    if timed_out {
        return Fail::Timeout;
    }
    Fail::Js(thrown.map_or_else(|| e.to_string(), |v| message(&v)))
}

// `${e.message ?? e}`
fn message(v: &Value) -> String {
    let coerce = |v: &Value| v.get::<rquickjs::Coerced<String>>().map(|s| s.0).ok();
    if let Some(m) = v.as_object().and_then(|o| o.get::<_, Value>("message").ok()).filter(|m| !m.is_undefined() && !m.is_null()) {
        return coerce(&m).unwrap_or_default();
    }
    coerce(v).unwrap_or_else(|| "Unknown error".into())
}

fn throw(ctx: &Ctx, e: impl std::fmt::Display) -> rquickjs::Error {
    Exception::throw_message(ctx, &e.to_string())
}

// the only ways the JS side reaches the machine
fn host<'js>(ctx: &Ctx<'js>, deadline: Arc<AtomicU64>) -> rquickjs::Result<Object<'js>> {
    let h = Object::new(ctx.clone())?;
    h.set(
        "read",
        Function::new(ctx.clone(), |ctx: Ctx, p: String| std::fs::read_to_string(&p).map_err(|e| throw(&ctx, format!("{e}: {p}")))),
    )?;
    h.set("exists", Function::new(ctx.clone(), |p: String| Path::new(&p).exists()))?;
    h.set(
        "write",
        Function::new(ctx.clone(), |ctx: Ctx, p: String, s: String| std::fs::write(&p, s).map_err(|e| throw(&ctx, format!("{e}: {p}")))),
    )?;
    h.set(
        "mkdirp",
        Function::new(ctx.clone(), |ctx: Ctx, p: String| std::fs::create_dir_all(&p).map_err(|e| throw(&ctx, format!("{e}: {p}")))),
    )?;
    // path.resolve(path.dirname(file), p)
    h.set(
        "resolve",
        Function::new(ctx.clone(), |file: String, p: String| {
            crate::resolve(Path::new(&file).parent().unwrap_or(Path::new("")), Path::new(&p)).to_string_lossy().into_owned()
        }),
    )?;
    h.set("random", Function::new(ctx.clone(), |n: usize| (0..n).map(|_| rand::random::<u8>()).collect::<Vec<u8>>()))?;
    let d = deadline.clone();
    h.set("arm", Function::new(ctx.clone(), move |ms: f64| d.store(now_ms() + ms as u64, Ordering::Relaxed)))?;
    h.set("disarm", Function::new(ctx.clone(), move || deadline.store(0, Ordering::Relaxed)))?;
    Ok(h)
}
