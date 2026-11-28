mod common;

use common::*;
use goat2_thread_store::StoreError;
use goat2_thread_store::contract::*;
use serde_json::json;

#[test]
fn a_large_answer_moves_to_a_blob_and_reconstructs_exactly() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("b", "/w"))
        .unwrap();
    let full: String = (0..70_000)
        .map(|i| char::from(b'a' + (i % 26) as u8))
        .collect::<String>()
        + "가나다";
    let out = store
        .append(
            &t,
            vec![
                input("i1", "q"),
                started("r1", &["i1"]),
                answer("r1", "a1", &full),
            ],
        )
        .unwrap();
    let LogEvent::ItemCompleted(item) = &out.lines[2].event else {
        panic!()
    };
    let blob = item.blob.as_ref().expect("blob ref");
    assert!(blob.path.starts_with("blobs/a1-"));
    assert_eq!(blob.size_bytes as usize, full.len());
    let TurnItemBody::AssistantMessage { text, .. } = &item.item.body else {
        panic!()
    };
    assert_eq!(text.len(), 2048);
    assert!(full.starts_with(text.as_str()));
    assert_eq!(store.read_blob(&t, blob).unwrap(), full.as_bytes());
    let longest = log_text(dir.path(), "t")
        .lines()
        .map(str::len)
        .max()
        .unwrap();
    assert!(longest < BLOB_THRESHOLD_BYTES);
}

#[test]
fn tool_output_is_never_stored() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("b", "/w"))
        .unwrap();
    let out = store
        .append(
            &t,
            vec![
                input("i1", "q"),
                started("r1", &["i1"]),
                item("r1", "c1", json!({"type": "command_execution", "input": "ls", "output": "x".repeat(200_000)})),
                item("r1", "d1", json!({"type": "dynamic_tool", "toolName": "t", "input": {}, "output": {"big": "y".repeat(10)}})),
            ],
        )
        .unwrap();
    let LogEvent::ItemCompleted(c) = &out.lines[2].event else {
        panic!()
    };
    let TurnItemBody::CommandExecution {
        output,
        output_omitted,
        ..
    } = &c.item.body
    else {
        panic!()
    };
    assert!(output.is_none());
    assert_eq!(*output_omitted, Some(true));
    assert!(c.blob.is_none());
    let LogEvent::ItemCompleted(d) = &out.lines[3].event else {
        panic!()
    };
    let TurnItemBody::DynamicTool {
        output,
        output_omitted,
        ..
    } = &d.item.body
    else {
        panic!()
    };
    assert!(output.is_none() && *output_omitted == Some(true));
}

#[test]
fn an_oversized_item_without_a_blob_field_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("b", "/w"))
        .unwrap();
    store
        .append(&t, vec![input("i1", "q"), started("r1", &["i1"])])
        .unwrap();
    let todo = item(
        "r1",
        "td",
        json!({"type": "todo_list", "planId": "p", "steps": [], "explanation": "e".repeat(80_000)}),
    );
    assert!(matches!(
        store.append(&t, vec![todo]),
        Err(StoreError::PayloadTooLarge(_))
    ));
    assert_eq!(store.card(&t).unwrap().unwrap().applied_seq, 3);
}

#[test]
fn blob_paths_cannot_escape_or_follow_links() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("b", "/w"))
        .unwrap();
    let blob = store.put_blob(&t, "upload.png", b"bytes").unwrap();
    assert_eq!(store.read_blob(&t, &blob).unwrap(), b"bytes");
    for bad in [
        "blobs/../card.json",
        "card.json",
        "blobs/",
        "blobs/.hidden",
        "blobs/a/b",
        "/etc/passwd",
    ] {
        let r = BlobRef {
            path: bad.into(),
            size_bytes: 0,
        };
        assert!(
            matches!(store.read_blob(&t, &r), Err(StoreError::InvalidBlobPath(_))),
            "{bad}"
        );
    }
    #[cfg(unix)]
    {
        let blobs = dir.path().join("threads/t/blobs");
        std::os::unix::fs::symlink(
            dir.path().join("threads/t/card.json"),
            blobs.join("link.txt"),
        )
        .unwrap();
        let r = BlobRef {
            path: "blobs/link.txt".into(),
            size_bytes: 0,
        };
        assert!(matches!(
            store.read_blob(&t, &r),
            Err(StoreError::InvalidBlobPath(_))
        ));
        // blobs/ itself replaced by a symlink to another folder.
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::write(
            elsewhere.join(blob.path.trim_start_matches("blobs/")),
            b"other",
        )
        .unwrap();
        std::fs::rename(&blobs, dir.path().join("moved")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &blobs).unwrap();
        assert!(matches!(
            store.read_blob(&t, &blob),
            Err(StoreError::InvalidBlobPath(_))
        ));
    }
}
