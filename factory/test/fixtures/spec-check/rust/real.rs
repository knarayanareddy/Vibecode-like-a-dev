use crate::shadow::compare_response;

// @anchor __REQ__
#[test]
fn compares_shadow_payloads() {
    let diff = compare_response(b"ok", b"ok");
    assert!(diff.is_empty());
}
