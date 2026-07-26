use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use base64::Engine;
use prost::Message;
use prost_reflect::{DescriptorPool, DynamicMessage, SerializeOptions};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::error::{self, Error};

// Built descriptor pools cached by their base64 descriptor set, so a decode
// following an import (or repeated decodes) skips re-parsing the FileDescriptorSet.
#[derive(Default)]
pub struct CodecState(Mutex<HashMap<String, DescriptorPool>>);

// Re-imports mint new descriptor sets; bound the cache so stale pools don't
// accumulate for the process lifetime.
const POOL_CACHE_CAP: usize = 16;

impl CodecState {
    fn pool_for(&self, descriptor_set_b64: &str) -> error::Result<DescriptorPool> {
        if let Some(pool) = self
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(descriptor_set_b64)
        {
            return Ok(pool.clone());
        }
        let bytes = decode_b64(descriptor_set_b64, "descriptor set")?;
        let pool = DescriptorPool::decode(bytes.as_slice())
            .map_err(|e| Error::InvalidInput(format!("invalid descriptor set: {e}")))?;
        self.cache(descriptor_set_b64.to_string(), pool.clone());
        Ok(pool)
    }

    fn cache(&self, descriptor_set_b64: String, pool: DescriptorPool) {
        let mut map = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if map.len() >= POOL_CACHE_CAP && !map.contains_key(&descriptor_set_b64) {
            map.clear();
        }
        map.insert(descriptor_set_b64, pool);
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSchema {
    name: String,
    descriptor_set_b64: String,
    message_types: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodeReq {
    codec: String,
    payload_b64: String,
    descriptor_set_b64: Option<String>,
    message_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodeResult {
    json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeReq {
    codec: String,
    json: String,
    descriptor_set_b64: Option<String>,
    message_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeResult {
    payload_b64: String,
}

fn decode_b64(s: &str, what: &str) -> error::Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| Error::InvalidInput(format!("invalid base64 {what}: {e}")))
}

fn encode_b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn message_descriptor(
    proto: Option<(&DescriptorPool, &str)>,
) -> error::Result<prost_reflect::MessageDescriptor> {
    let (pool, message_type) = proto.ok_or_else(|| {
        Error::InvalidInput("protobuf requires a descriptor set and message type".into())
    })?;
    pool.get_message_by_name(message_type).ok_or_else(|| {
        Error::InvalidInput(format!(
            "message type '{message_type}' not found in descriptor set"
        ))
    })
}

fn decode_bytes(
    codec: &str,
    bytes: &[u8],
    proto: Option<(&DescriptorPool, &str)>,
) -> error::Result<String> {
    let value: serde_json::Value = match codec {
        "protobuf" => {
            let desc = message_descriptor(proto)?;
            let msg = DynamicMessage::decode(desc, bytes)
                .map_err(|e| Error::InvalidInput(format!("protobuf decode failed: {e}")))?;
            // A viewer should show default-valued fields, not hide them.
            let opts = SerializeOptions::new()
                .stringify_64_bit_integers(true)
                .use_proto_field_name(false)
                .skip_default_fields(false);
            msg.serialize_with_options(serde_json::value::Serializer, &opts)
                .map_err(|e| Error::InvalidInput(format!("protobuf serialize failed: {e}")))?
        }
        "msgpack" => rmp_serde::from_slice(bytes)
            .map_err(|e| Error::InvalidInput(format!("msgpack decode failed: {e}")))?,
        "cbor" => ciborium::from_reader(bytes)
            .map_err(|e| Error::InvalidInput(format!("cbor decode failed: {e}")))?,
        other => return Err(Error::InvalidInput(format!("unknown codec '{other}'"))),
    };
    serde_json::to_string_pretty(&value)
        .map_err(|e| Error::InvalidInput(format!("json serialize failed: {e}")))
}

fn encode_bytes(
    codec: &str,
    json: &str,
    proto: Option<(&DescriptorPool, &str)>,
) -> error::Result<Vec<u8>> {
    match codec {
        "protobuf" => {
            let desc = message_descriptor(proto)?;
            let mut de = serde_json::Deserializer::from_str(json);
            let msg = DynamicMessage::deserialize(desc, &mut de)
                .map_err(|e| Error::InvalidInput(format!("protobuf encode failed: {e}")))?;
            de.end()
                .map_err(|e| Error::InvalidInput(format!("protobuf encode failed: {e}")))?;
            Ok(msg.encode_to_vec())
        }
        "msgpack" => {
            let value = parse_json(json)?;
            rmp_serde::to_vec(&value)
                .map_err(|e| Error::InvalidInput(format!("msgpack encode failed: {e}")))
        }
        "cbor" => {
            let value = parse_json(json)?;
            let mut buf = Vec::new();
            ciborium::into_writer(&value, &mut buf)
                .map_err(|e| Error::InvalidInput(format!("cbor encode failed: {e}")))?;
            Ok(buf)
        }
        other => Err(Error::InvalidInput(format!("unknown codec '{other}'"))),
    }
}

fn parse_json(json: &str) -> error::Result<serde_json::Value> {
    serde_json::from_str(json).map_err(|e| Error::InvalidInput(format!("invalid json: {e}")))
}

/// Drops `//` and `/* */` comments, leaving string literals untouched so a path
/// containing `//` survives. Statement scanning below would otherwise treat a
/// comment as the head of the statement and miss the `import` that follows it.
fn strip_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            out.push(c);
            if c == '\\' {
                if let Some(escaped) = chars.next() {
                    out.push(escaped);
                }
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => {
                quote = Some(c);
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
                out.push('\n');
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                for c in chars.by_ref() {
                    if prev == '*' && c == '/' {
                        break;
                    }
                    prev = c;
                }
                out.push(' ');
            }
            _ => out.push(c),
        }
    }
    out
}

fn proto_imports(src: &str) -> Vec<String> {
    strip_comments(src)
        .split(';')
        .filter_map(|stmt| {
            let after = stmt.trim().strip_prefix("import")?;
            // `import` must be a whole token, not the head of an identifier.
            if !after.starts_with(|c: char| c.is_whitespace() || c == '"' || c == '\'') {
                return None;
            }
            let rest = after.trim_start();
            let rest = rest
                .strip_prefix("public")
                .or_else(|| rest.strip_prefix("weak"))
                .map(str::trim_start)
                .unwrap_or(rest);
            let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
            let rest = rest.strip_prefix(quote)?;
            rest.split(quote).next().map(str::to_string)
        })
        .collect()
}

fn compile_protos(paths: &[PathBuf]) -> error::Result<(ImportedSchema, DescriptorPool)> {
    // protoc semantics: a file's canonical name must match the string its
    // importers use, so derive include roots from the set's import statements
    // and pass root-relative names (fallback: parent dir + bare filename).
    let mut imports: Vec<String> = Vec::new();
    for p in paths {
        let src = std::fs::read_to_string(p).map_err(|source| Error::Io {
            path: p.display().to_string(),
            source,
        })?;
        imports.extend(proto_imports(&src));
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for p in paths {
        let ps = p.to_string_lossy().replace('\\', "/");
        let import_name = imports.iter().find_map(|imp| {
            ps.strip_suffix(&format!("/{imp}"))
                .map(|root| (PathBuf::from(root), imp.clone()))
        });
        let name = match import_name {
            Some((root, name)) => {
                if !roots.contains(&root) {
                    roots.push(root);
                }
                name
            }
            None => {
                if let Some(dir) = p.parent() {
                    let dir = dir.to_path_buf();
                    if !roots.contains(&dir) {
                        roots.push(dir);
                    }
                }
                p.file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| ps.clone())
            }
        };
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let fds = protox::compile(&names, &roots)
        .map_err(|e| Error::InvalidInput(format!("proto compile failed: {e}")))?;
    let bytes = fds.encode_to_vec();
    let descriptor_set_b64 = encode_b64(&bytes);
    let pool = DescriptorPool::decode(bytes.as_slice())
        .map_err(|e| Error::InvalidInput(format!("invalid descriptor set: {e}")))?;
    let mut message_types: Vec<String> = pool
        .all_messages()
        .map(|m| m.full_name().to_string())
        .collect();
    message_types.sort();
    message_types.dedup();
    let name = paths
        .first()
        .and_then(|p| p.file_stem())
        .and_then(|s| s.to_str())
        .unwrap_or("schema")
        .to_string();
    Ok((
        ImportedSchema {
            name,
            descriptor_set_b64,
            message_types,
        },
        pool,
    ))
}

#[tauri::command]
pub async fn codec_import_protos(
    app: AppHandle,
    codecs: State<'_, CodecState>,
) -> error::Result<Option<ImportedSchema>> {
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Protobuf", &["proto"])
            .blocking_pick_files()
    })
    .await
    .map_err(|e| Error::Task(e.to_string()))?;
    let Some(files) = picked else {
        return Ok(None);
    };
    let paths: Vec<PathBuf> = files
        .into_iter()
        .filter_map(|f| f.as_path().map(Path::to_path_buf))
        .collect();
    if paths.is_empty() {
        return Ok(None);
    }
    let (schema, pool) = tokio::task::spawn_blocking(move || compile_protos(&paths))
        .await
        .map_err(|e| Error::Task(e.to_string()))??;
    codecs.cache(schema.descriptor_set_b64.clone(), pool);
    Ok(Some(schema))
}

#[tauri::command]
pub async fn codec_decode(
    codecs: State<'_, CodecState>,
    req: DecodeReq,
) -> error::Result<DecodeResult> {
    let bytes = decode_b64(&req.payload_b64, "payload")?;
    let json = if req.codec == "protobuf" {
        let pool = codecs.pool_for(require(
            req.descriptor_set_b64.as_deref(),
            "descriptorSetB64",
        )?)?;
        let message_type = require(req.message_type.as_deref(), "messageType")?;
        decode_bytes(&req.codec, &bytes, Some((&pool, message_type)))?
    } else {
        decode_bytes(&req.codec, &bytes, None)?
    };
    Ok(DecodeResult { json })
}

#[tauri::command]
pub async fn codec_encode(
    codecs: State<'_, CodecState>,
    req: EncodeReq,
) -> error::Result<EncodeResult> {
    let bytes = if req.codec == "protobuf" {
        let pool = codecs.pool_for(require(
            req.descriptor_set_b64.as_deref(),
            "descriptorSetB64",
        )?)?;
        let message_type = require(req.message_type.as_deref(), "messageType")?;
        encode_bytes(&req.codec, &req.json, Some((&pool, message_type)))?
    } else {
        encode_bytes(&req.codec, &req.json, None)?
    };
    Ok(EncodeResult {
        payload_b64: encode_b64(&bytes),
    })
}

fn require<'a>(value: Option<&'a str>, field: &str) -> error::Result<&'a str> {
    value.ok_or_else(|| Error::InvalidInput(format!("protobuf requires '{field}'")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_pool() -> DescriptorPool {
        let dir = tempfile::tempdir().unwrap();
        let proto = dir.path().join("t.proto");
        std::fs::write(
            &proto,
            r#"
                syntax = "proto3";
                package t;
                message Person {
                    string name = 1;
                    int64 age = 2;
                    repeated string tags = 3;
                }
            "#,
        )
        .unwrap();
        let (_, pool) = compile_protos(&[proto]).unwrap();
        pool
    }

    fn value(s: &str) -> serde_json::Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn protobuf_round_trips() {
        let pool = test_pool();
        let input = r#"{"name":"Ada","age":"42","tags":["x","y"]}"#;
        let bytes = encode_bytes("protobuf", input, Some((&pool, "t.Person"))).unwrap();
        let out = decode_bytes("protobuf", &bytes, Some((&pool, "t.Person"))).unwrap();
        assert_eq!(value(input), value(&out));
    }

    #[test]
    fn msgpack_round_trips() {
        let input = r#"{"a":1,"b":["x",true],"c":null}"#;
        let bytes = encode_bytes("msgpack", input, None).unwrap();
        let out = decode_bytes("msgpack", &bytes, None).unwrap();
        assert_eq!(value(input), value(&out));
    }

    #[test]
    fn cbor_round_trips() {
        let input = r#"{"a":1,"b":["x",true],"c":null}"#;
        let bytes = encode_bytes("cbor", input, None).unwrap();
        let out = decode_bytes("cbor", &bytes, None).unwrap();
        assert_eq!(value(input), value(&out));
    }

    #[test]
    fn imported_schema_lists_message_types() {
        let dir = tempfile::tempdir().unwrap();
        let proto = dir.path().join("t.proto");
        std::fs::write(
            &proto,
            "syntax = \"proto3\"; package t; message Person { string name = 1; }",
        )
        .unwrap();
        let (schema, _) = compile_protos(&[proto]).unwrap();
        assert_eq!(schema.name, "t");
        assert!(schema.message_types.contains(&"t.Person".to_string()));
        assert!(!schema.descriptor_set_b64.is_empty());
    }

    #[test]
    fn root_relative_imports_resolve_via_ancestor_includes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("myapp/common")).unwrap();
        std::fs::write(
            dir.path().join("myapp/common/types.proto"),
            "syntax = \"proto3\"; package myapp.common; message Id { string v = 1; }",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("myapp/order.proto"),
            "syntax = \"proto3\"; package myapp; import \"myapp/common/types.proto\"; message Order { myapp.common.Id id = 1; }",
        )
        .unwrap();
        let (schema, _) = compile_protos(&[
            dir.path().join("myapp/order.proto"),
            dir.path().join("myapp/common/types.proto"),
        ])
        .unwrap();
        assert!(schema.message_types.contains(&"myapp.Order".to_string()));
    }

    #[test]
    fn imports_are_found_behind_comments() {
        let src = r#"
            syntax = "proto3";
            package myapp;

            // shared types
            import "myapp/common/types.proto";
            /* block */ import public "myapp/common/ids.proto";
            // import "myapp/commented_out.proto";
            import 'myapp/single_quoted.proto';
            message Order { string id = 1; }
        "#;
        assert_eq!(
            proto_imports(src),
            vec![
                "myapp/common/types.proto",
                "myapp/common/ids.proto",
                "myapp/single_quoted.proto",
            ]
        );
    }

    #[test]
    fn comment_before_import_still_resolves_include_roots() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("myapp/common")).unwrap();
        std::fs::write(
            dir.path().join("myapp/common/types.proto"),
            "syntax = \"proto3\"; package myapp.common; message Id { string v = 1; }",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("myapp/order.proto"),
            "syntax = \"proto3\";\npackage myapp;\n\n// shared types\nimport \"myapp/common/types.proto\";\nmessage Order { myapp.common.Id id = 1; }",
        )
        .unwrap();
        let (schema, _) = compile_protos(&[
            dir.path().join("myapp/order.proto"),
            dir.path().join("myapp/common/types.proto"),
        ])
        .unwrap();
        assert!(schema.message_types.contains(&"myapp.Order".to_string()));
    }

    #[test]
    fn decoded_protobuf_shows_default_fields() {
        let pool = test_pool();
        let bytes = encode_bytes("protobuf", "{}", Some((&pool, "t.Person"))).unwrap();
        let out = decode_bytes("protobuf", &bytes, Some((&pool, "t.Person"))).unwrap();
        let v = value(&out);
        assert_eq!(v["name"], "");
        assert_eq!(v["age"], "0");
    }

    #[test]
    fn pool_cache_is_bounded() {
        let state = CodecState::default();
        for i in 0..(POOL_CACHE_CAP + 4) {
            state.cache(format!("k{i}"), test_pool());
        }
        let len = state.0.lock().unwrap().len();
        assert!(len <= POOL_CACHE_CAP);
    }

    #[test]
    fn unknown_message_type_is_invalid_input() {
        let pool = test_pool();
        let err = decode_bytes("protobuf", &[], Some((&pool, "t.Missing"))).unwrap_err();
        assert_eq!(err.kind(), "invalidInput");
    }

    #[test]
    fn protobuf_without_descriptor_is_invalid_input() {
        assert_eq!(
            decode_bytes("protobuf", b"", None).unwrap_err().kind(),
            "invalidInput"
        );
        assert_eq!(
            encode_bytes("protobuf", "{}", None).unwrap_err().kind(),
            "invalidInput"
        );
    }

    #[test]
    fn unknown_codec_is_invalid_input() {
        assert_eq!(
            decode_bytes("yaml", b"x", None).unwrap_err().kind(),
            "invalidInput"
        );
        assert_eq!(
            encode_bytes("yaml", "{}", None).unwrap_err().kind(),
            "invalidInput"
        );
    }

    #[test]
    fn bad_base64_is_invalid_input() {
        assert_eq!(
            decode_b64("not base64!", "payload").unwrap_err().kind(),
            "invalidInput"
        );
    }
}
