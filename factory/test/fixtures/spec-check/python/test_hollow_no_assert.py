from app.billing import calculate_total


# @anchor __REQ__
def test_calls_without_asserting():
    calculate_total([120, 80])
