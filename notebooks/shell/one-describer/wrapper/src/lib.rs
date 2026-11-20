//! The host's describer (manifest.rs, script_grammar.rs, unmodified) behind a raw wasm ABI, for the one-describer
//! notebook. `build.sh` links `wrapper/host` to a window-ml-host checkout.
#![allow(dead_code, unused)]
#[path = "../host/src/script_grammar.rs"]
mod script_grammar;
#[path = "../host/src/manifest.rs"]
mod manifest;

use manifest::{Flavour, Manifest, describe_call_as, harden_argv};
use serde_json::{Value, json};

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, cap: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, cap.max(1))) }
}

fn run(req: &[u8]) -> Value {
    let v: Value = match serde_json::from_slice(req) { Ok(v) => v, Err(e) => return json!({"error": format!("request: {e}")}) };
    let argv: Vec<String> = v["argv"].as_array().map(|a| a.iter().map(|s| s.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default();
    let m: Manifest = match serde_json::from_value(v["manifest"].clone()) { Ok(m) => m, Err(e) => return json!({"error": format!("manifest: {e}")}) };
    let version = v["version"].as_str();
    let env: Vec<String> = v["envSet"].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default();
    let flavour = match v["flavour"].as_str() { Some("gnu") => Some(Flavour::Gnu), Some("bsd") => Some(Flavour::Bsd), Some("other") => Some(Flavour::Other), _ => None };
    let d = describe_call_as(&argv, &m, version, &env, flavour);
    let hardened = harden_argv(&argv, &d);
    json!({
        "described": d.described, "why": d.why, "program": d.program, "subcommand": d.subcommand,
        "effects": d.effects.to_json(), "pathArgs": serde_json::to_value(&d.path_args).unwrap(),
        "actsOnDir": d.acts_on_dir, "dirArg": d.dir_arg, "recursive": d.recursive,
        "harden": d.harden.iter().map(|h| json!({"at": h.at, "args": h.args})).collect::<Vec<_>>(),
        "operandStart": d.operand_start, "terminator": serde_json::to_value(&d.terminator).unwrap(),
        "runner": d.runner, "echoes": d.echoes, "okCodes": d.ok_codes, "hardened": hardened,
    })
}

/// Returns a pointer to [u32 LE length][JSON]; free with dealloc(ptr, 4 + length).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn describe(ptr: *const u8, len: usize) -> *mut u8 {
    let req = unsafe { std::slice::from_raw_parts(ptr, len) };
    let out = serde_json::to_vec(&run(req)).unwrap();
    let mut buf = Vec::with_capacity(4 + out.len());
    buf.extend_from_slice(&(out.len() as u32).to_le_bytes());
    buf.extend_from_slice(&out);
    let mut b = buf.into_boxed_slice();
    let p = b.as_mut_ptr();
    std::mem::forget(b);
    p
}
