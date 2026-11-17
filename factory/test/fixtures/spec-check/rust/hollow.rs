use std::collections::HashMap;
use proptest::prelude::*;

// @anchor __REQ__
#[test]
fn imports_only_std_and_test_crate() {
    let mut map = HashMap::new();
    map.insert("k", 1);
    assert_eq!(map.len(), 1);
}
