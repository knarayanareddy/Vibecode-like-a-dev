# frozen_string_literal: true

require 'rspec'
require 'spec_helper'

RSpec.describe 'Hollow' do
  # @anchor __REQ__
  it '__REQ__ requires only rspec and spec_helper' do
    items = [1, 2, 3]
    expect(items.length).to eq(3)
  end
end
