package main

import (
	"testing"
)

func TestFeeConfig_CalculateFee(t *testing.T) {
	tests := []struct {
		name            string
		config          FeeConfig
		baseAmountCents int64
		expectedFee     int64
	}{
		{
			name: "fee disabled returns zero",
			config: FeeConfig{
				Enabled:   false,
				Percent:   2.9,
				FlatCents: 30,
			},
			baseAmountCents: 10000, // $100
			expectedFee:     0,
		},
		{
			name: "standard 2.9% + $0.30 on $100",
			config: FeeConfig{
				Enabled:   true,
				Percent:   2.9,
				FlatCents: 30,
			},
			baseAmountCents: 10000, // $100
			expectedFee:     320,   // $2.90 + $0.30 = $3.20
		},
		{
			name: "percent only (no flat fee)",
			config: FeeConfig{
				Enabled:   true,
				Percent:   2.5,
				FlatCents: 0,
			},
			baseAmountCents: 10000, // $100
			expectedFee:     250,   // $2.50
		},
		{
			name: "flat only (no percent)",
			config: FeeConfig{
				Enabled:   true,
				Percent:   0,
				FlatCents: 30,
			},
			baseAmountCents: 10000, // $100
			expectedFee:     30,    // $0.30
		},
		{
			name: "small amount $1 with standard fees",
			config: FeeConfig{
				Enabled:   true,
				Percent:   2.9,
				FlatCents: 30,
			},
			baseAmountCents: 100, // $1
			expectedFee:     33,  // $0.029 rounds to $0.03 + $0.30 = $0.33
		},
		{
			name: "rounding test - rounds to nearest cent",
			config: FeeConfig{
				Enabled:   true,
				Percent:   2.9,
				FlatCents: 30,
			},
			baseAmountCents: 1234, // $12.34
			// 1234 * 0.029 = 35.786 -> rounds to 36
			// 36 + 30 = 66 cents = $0.66
			expectedFee: 66,
		},
		{
			name: "large amount $1000",
			config: FeeConfig{
				Enabled:   true,
				Percent:   2.9,
				FlatCents: 30,
			},
			baseAmountCents: 100000, // $1000
			expectedFee:     2930,   // $29.00 + $0.30 = $29.30
		},
		{
			name: "zero amount returns flat fee only",
			config: FeeConfig{
				Enabled:   true,
				Percent:   2.9,
				FlatCents: 30,
			},
			baseAmountCents: 0,
			expectedFee:     30, // Just the flat fee
		},
		{
			name: "high percent fee 10%",
			config: FeeConfig{
				Enabled:   true,
				Percent:   10.0,
				FlatCents: 0,
			},
			baseAmountCents: 5000, // $50
			expectedFee:     500,  // $5.00
		},
		{
			name: "fractional percent 0.5%",
			config: FeeConfig{
				Enabled:   true,
				Percent:   0.5,
				FlatCents: 0,
			},
			baseAmountCents: 10000, // $100
			expectedFee:     50,    // $0.50
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := tt.config.CalculateFee(tt.baseAmountCents)
			if result != tt.expectedFee {
				t.Errorf("CalculateFee(%d) = %d, want %d",
					tt.baseAmountCents, result, tt.expectedFee)
			}
		})
	}
}

func TestFeeConfig_Refundable(t *testing.T) {
	// Test that the Refundable field is properly stored (used for auditing)
	config := FeeConfig{
		Enabled:    true,
		Percent:    2.9,
		FlatCents:  30,
		Refundable: false,
	}

	if config.Refundable != false {
		t.Error("Expected Refundable to be false by default")
	}

	config.Refundable = true
	if config.Refundable != true {
		t.Error("Expected Refundable to be true after setting")
	}
}

// Test examples from the plan documentation
func TestFeeConfig_DocumentedExamples(t *testing.T) {
	// From plan: $100 base + 2.9% + $0.30 = $103.20 total
	config := FeeConfig{
		Enabled:   true,
		Percent:   2.9,
		FlatCents: 30,
	}

	baseAmount := int64(10000) // $100.00 in cents
	fee := config.CalculateFee(baseAmount)
	expectedFee := int64(320) // $3.20 in cents

	if fee != expectedFee {
		t.Errorf("Documentation example: expected fee %d cents, got %d cents", expectedFee, fee)
	}

	totalAmount := baseAmount + fee
	expectedTotal := int64(10320) // $103.20 in cents

	if totalAmount != expectedTotal {
		t.Errorf("Documentation example: expected total %d cents, got %d cents", expectedTotal, totalAmount)
	}
}

// Benchmark fee calculation performance
func BenchmarkCalculateFee(b *testing.B) {
	config := FeeConfig{
		Enabled:   true,
		Percent:   2.9,
		FlatCents: 30,
	}

	baseAmount := int64(10000) // $100

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		config.CalculateFee(baseAmount)
	}
}
