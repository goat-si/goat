use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    process::{Command, Stdio},
    sync::{
        Arc, Barrier,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
};

fn command() -> Command {
    Command::new(env!("CARGO_BIN_EXE_goat2-acp-mcp-bridge"))
}
fn read_request(stream: &mut TcpStream) -> (String, Value) {
    let mut data = Vec::new();
    let mut b = [0; 1];
    while !data.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut b).unwrap();
        data.push(b[0]);
    }
    let headers = String::from_utf8(data).unwrap().to_lowercase();
    let length: usize = headers
        .lines()
        .find_map(|l| l.strip_prefix("content-length: "))
        .unwrap()
        .parse()
        .unwrap();
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    (headers, serde_json::from_slice(&body).unwrap())
}
fn reply(stream: &mut TcpStream, status: &str, headers: &str, body: &str) {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
        body.len()
    )
    .unwrap();
}
#[test]
fn real_binary_relays_session_sse_errors_concurrency_and_eof() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let stage = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(Barrier::new(2));
    let server = thread::spawn(move || {
        let mut threads = Vec::new();
        for _ in 0..6 {
            let (mut stream, _) = listener.accept().unwrap();
            let stage = stage.clone();
            let gate = gate.clone();
            threads.push(thread::spawn(move || {
                let (headers, message) = read_request(&mut stream);
                assert!(headers.contains("authorization: bearer test-secret\r\n"));
                let method = message["method"].as_str().unwrap();
                if method == "initialize" {
                    assert_eq!(stage.load(Ordering::SeqCst), 0);
                    stage.store(1, Ordering::SeqCst);
                    reply(&mut stream, "200 OK", "Content-Type: application/json\r\nMcp-Session-Id: session-1\r\n", &json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26"}}).to_string());
                } else {
                    assert!(headers.contains("mcp-session-id: session-1\r\n"));
                    assert!(headers.contains("mcp-protocol-version: 2025-03-26\r\n"));
                    if method == "notifications/initialized" {
                        assert_eq!(stage.swap(2, Ordering::SeqCst), 1);
                        reply(&mut stream, "202 Accepted", "", "");
                    } else {
                        assert_eq!(stage.load(Ordering::SeqCst), 2);
                        match method {
                            "slow" => { gate.wait(); reply(&mut stream, "200 OK", "Content-Type: application/json\r\n", &json!({"jsonrpc":"2.0","id":2,"result":"slow"}).to_string()); }
                            "fast" => { gate.wait(); reply(&mut stream, "200 OK", "Content-Type: text/event-stream; charset=utf-8\r\n", "data: {\"jsonrpc\":\"2.0\",\"method\":\"notice\"}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":\"fast\"}\n\n"); }
                            _ => reply(&mut stream, "500 Internal Server Error", "", "failure"),
                        }
                    }
                }
            }));
        }
        for task in threads {
            task.join().unwrap();
        }
    });
    let mut cmd = command();
    cmd.env("GOAT_ACP_MCP_ENDPOINT", endpoint)
        .env("GOAT_ACP_MCP_AUTHORIZATION", "Bearer test-secret")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    assert!(
        cmd.get_args()
            .all(|a| !a.to_string_lossy().contains("test-secret"))
    );
    let mut child = cmd.spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    for message in [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"slow"}),
        json!({"jsonrpc":"2.0","id":3,"method":"fast"}),
        json!({"jsonrpc":"2.0","method":"bad-note"}),
        json!({"jsonrpc":"2.0","id":4,"method":"bad"}),
    ] {
        writeln!(input, "{message}").unwrap();
    }
    drop(input);
    let result = child.wait_with_output().unwrap();
    assert!(result.status.success());
    server.join().unwrap();
    let values: Vec<Value> = String::from_utf8(result.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(values.len(), 5);
    assert!(values.iter().any(|v| v["id"] == 2 && v["result"] == "slow"));
    assert!(values.iter().any(|v| v["id"] == 3 && v["result"] == "fast"));
    assert!(values.iter().any(|v| v["method"] == "notice"));
    assert!(
        values.iter().any(|v| v["id"] == 4
            && v["error"]["message"] == "GOAT MCP endpoint responded with HTTP 500.")
    );
}
#[test]
fn missing_environment_exits_two() {
    let out = command()
        .env_remove("GOAT_ACP_MCP_ENDPOINT")
        .env_remove("GOAT_ACP_MCP_AUTHORIZATION")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(
        String::from_utf8(out.stderr).unwrap(),
        "acp-mcp-bridge requires GOAT_ACP_MCP_ENDPOINT and GOAT_ACP_MCP_AUTHORIZATION.\n"
    );
}
#[test]
fn bad_and_oversized_lines_are_rejected() {
    let mut child = command()
        .env("GOAT_ACP_MCP_ENDPOINT", "http://127.0.0.1:1")
        .env("GOAT_ACP_MCP_AUTHORIZATION", "token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(input, "bad json").unwrap();
    input.write_all(&vec![b'x'; 16 * 1024 * 1024 + 1]).unwrap();
    writeln!(input).unwrap();
    drop(input);
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    let lines: Vec<Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines[0]["error"]["code"], -32700);
    assert_eq!(lines[1]["error"]["code"], -32600);
}

#[test]
fn agent_response_bypasses_open_initialize_stream() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut initialize, _) = listener.accept().unwrap();
        let (_, value) = read_request(&mut initialize);
        assert_eq!(value["method"], "initialize");
        write!(initialize, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
        let event = "data: {\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"ping\"}\n\n";
        write!(initialize, "{:x}\r\n{}\r\n", event.len(), event).unwrap();
        let (mut response, _) = listener.accept().unwrap();
        let (_, value) = read_request(&mut response);
        assert_eq!(value["id"], 99);
        assert_eq!(value["result"], json!({}));
        reply(&mut response, "202 Accepted", "", "");
        let event = "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n";
        write!(initialize, "{:x}\r\n{}\r\n0\r\n\r\n", event.len(), event).unwrap();
    });
    let mut child = command()
        .env("GOAT_ACP_MCP_ENDPOINT", endpoint)
        .env("GOAT_ACP_MCP_AUTHORIZATION", "token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","id":1,"method":"initialize"})
    )
    .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut first = String::new();
    stdout.read_line(&mut first).unwrap();
    let first: Value = serde_json::from_str(&first).unwrap();
    assert_eq!(first["method"], "ping");
    writeln!(input, "{}", json!({"jsonrpc":"2.0","id":99,"result":{}})).unwrap();
    drop(input);
    let mut rest = String::new();
    stdout.read_to_string(&mut rest).unwrap();
    assert!(child.wait().unwrap().success());
    server.join().unwrap();
    let values: Vec<Value> = rest
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert!(values.iter().any(|v| v["id"] == 1));
}

#[test]
fn transport_failure_replies_to_request() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let _ = read_request(&mut stream);
    });
    let mut child = command()
        .env("GOAT_ACP_MCP_ENDPOINT", endpoint)
        .env("GOAT_ACP_MCP_AUTHORIZATION", "token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(
        child.stdin.take().unwrap(),
        "{}",
        json!({"jsonrpc":"2.0","id":4,"method":"test"})
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    server.join().unwrap();
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["id"], 4);
    assert!(
        value["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("GOAT MCP bridge request failed: ")
    );
}
