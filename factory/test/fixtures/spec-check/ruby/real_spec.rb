# frozen_string_literal: true

require 'spec_helper'
require_relative '../lib/invoice_calculator'

RSpec.describe InvoiceCalculator do
  # @anchor __REQ__
  it '__REQ__ calculates line-item total' do
    calc = described_class.new
    expect(calc.sum([120, 80])).to eq(200)
  end
end
