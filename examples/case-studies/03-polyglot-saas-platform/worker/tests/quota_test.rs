use polyglot_worker::within_quota;

// @req REQ-019
// @req REQ-020
// @req REQ-021
// @req REQ-022
// @req REQ-023
// @req REQ-024
// @req REQ-C01
#[test]
fn enforces_hourly_export_quota() {
    assert_eq!(within_quota(9), true);
    assert_eq!(within_quota(10), false);
}
