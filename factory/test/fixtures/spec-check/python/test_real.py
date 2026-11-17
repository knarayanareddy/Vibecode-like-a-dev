import pytest
from app.billing import calculate_total


# @anchor __REQ__
def test_calculate_total():
    total = calculate_total([120, 80])
    assert total == 200
    with pytest.raises(ValueError):
        calculate_total([-1])
