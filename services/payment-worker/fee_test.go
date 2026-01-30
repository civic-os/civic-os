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
			name: "standard 2.9% + $0.30 on $100 (gross-up formula)",
			config: FeeConfig{
				Enabled:   true,
				Percent:   2.9,
				FlatCents: 30,
			},
			baseAmountCents: 10000, // $100
			// Gross-up: (10000 + 30) / (1 - 0.029) = 10329.25 -> fee = 329.25 -> ceil = 330
			expectedFee: 330,
		},
		{
			name: "percent only (no flat fee)",
			config: FeeConfig{
				Enabled:   true,
				Percent:   2.5,
				FlatCents: 0,
			},
			baseAmountCents: 10000, // $100
			// Gross-up: 10000 / (1 - 0.025) = 10256.41 -> fee = 256.41 -> ceil = 257
			expectedFee: 257,
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
			// Gross-up: (100 + 30) / (1 - 0.029) = 133.92 -> fee = 33.92 -> ceil = 34
			expectedFee: 34,
		},
		{
			name: "rounding test - rounds UP (ceil) to cover full amount",
			config: FeeConfig{
				Enabled:   true,
				Percent:   2.9,
				FlatCents: 30,
			},
			baseAmountCents: 1234, // $12.34
			// Gross-up: (1234 + 30) / (1 - 0.029) = 1301.75 -> fee = 67.75 -> ceil = 68
			expectedFee: 68,
		},
		{
			name: "large amount $1000",
			config: FeeConfig{
				Enabled:   true,
				Percent:   2.9,
				FlatCents: 30,
			},
			baseAmountCents: 100000, // $1000
			// Gross-up: (100000 + 30) / (1 - 0.029) = 103017.54 -> fee = 3017.54 -> ceil = 3018
			expectedFee: 3018,
		},
		{
			name: "zero amount returns flat fee only (grossed up)",
			config: FeeConfig{
				Enabled:   true,
				Percent:   2.9,
				FlatCents: 30,
			},
			baseAmountCents: 0,
			// Gross-up: (0 + 30) / (1 - 0.029) = 30.90 -> fee = 30.90 -> ceil = 31
			expectedFee: 31,
		},
		{
			name: "high percent fee 10%",
			config: FeeConfig{
				Enabled:   true,
				Percent:   10.0,
				FlatCents: 0,
			},
			baseAmountCents: 5000, // $50
			// Gross-up: 5000 / (1 - 0.10) = 5555.56 -> fee = 555.56 -> ceil = 556
			expectedFee: 556,
		},
		{
			name: "fractional percent 0.5%",
			config: FeeConfig{
				Enabled:   true,
				Percent:   0.5,
				FlatCents: 0,
			},
			baseAmountCents: 10000, // $100
			// Gross-up: 10000 / (1 - 0.005) = 10050.25 -> fee = 50.25 -> ceil = 51
			expectedFee: 51,
		},
		{
			name: "$150 payment - mottpark scenario (the bug that prompted this fix)",
			config: FeeConfig{
				Enabled:   true,
				Percent:   2.9,
				FlatCents: 30,
			},
			baseAmountCents: 15000, // $150.00
			// Gross-up: (15000 + 30) / (1 - 0.029) = 15478.84 -> fee = 478.84 -> ceil = 479
			// User pays: $154.79, Stripe takes: $154.79 × 2.9% + $0.30 = $4.79
			// Recipient gets: $154.79 - $4.79 = $150.00 ✓
			expectedFee: 479,
		},
		{
			name: "$50 payment scenario",
			config: FeeConfig{
				Enabled:   true,
				Percent:   2.9,
				FlatCents: 30,
			},
			baseAmountCents: 5000, // $50.00
			// Gross-up: (5000 + 30) / (1 - 0.029) = 5180.60 -> fee = 180.60 -> ceil = 181
			expectedFee: 181,
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

// Test the gross-up formula ensures recipient receives exact base amount
func TestFeeConfig_GrossUpFormula(t *testing.T) {
	config := FeeConfig{
		Enabled:   true,
		Percent:   2.9,
		FlatCents: 30,
	}

	// Test the $150 mottpark scenario that exposed the bug
	baseAmount := int64(15000) // $150.00 in cents
	fee := config.CalculateFee(baseAmount)
	expectedFee := int64(479) // $4.79 in cents (gross-up formula)

	if fee != expectedFee {
		t.Errorf("Gross-up formula: expected fee %d cents, got %d cents", expectedFee, fee)
	}

	totalAmount := baseAmount + fee
	expectedTotal := int64(15479) // $154.79 in cents

	if totalAmount != expectedTotal {
		t.Errorf("Gross-up formula: expected total %d cents, got %d cents", expectedTotal, totalAmount)
	}

	// Verify the math: Stripe takes 2.9% + $0.30 of the TOTAL
	stripePercent := float64(totalAmount) * 0.029 // $4.49
	stripeFlat := float64(30)                     // $0.30
	stripeTakes := stripePercent + stripeFlat     // $4.79

	recipientGets := float64(totalAmount) - stripeTakes
	expectedRecipient := float64(baseAmount)

	// Allow for floating point precision (should be within 1 cent)
	if recipientGets < expectedRecipient-1 || recipientGets > expectedRecipient+1 {
		t.Errorf("Recipient should get ~$%.2f, but gets $%.2f (Stripe takes $%.2f)",
			expectedRecipient/100, recipientGets/100, stripeTakes/100)
	}
}

// Test that $100 scenario also works correctly
func TestFeeConfig_HundredDollarScenario(t *testing.T) {
	config := FeeConfig{
		Enabled:   true,
		Percent:   2.9,
		FlatCents: 30,
	}

	baseAmount := int64(10000) // $100.00 in cents
	fee := config.CalculateFee(baseAmount)
	// Gross-up: (10000 + 30) / (1 - 0.029) = 10329.25 -> ceil(329.25) = 330
	expectedFee := int64(330)

	if fee != expectedFee {
		t.Errorf("$100 scenario: expected fee %d cents, got %d cents", expectedFee, fee)
	}

	totalAmount := baseAmount + fee // $103.30

	// Verify recipient gets at least $100
	stripeTakes := float64(totalAmount)*0.029 + 30 // 2.9% of total + $0.30
	recipientGets := float64(totalAmount) - stripeTakes

	if recipientGets < float64(baseAmount) {
		t.Errorf("$100 scenario: recipient gets $%.2f, should be at least $%.2f",
			recipientGets/100, float64(baseAmount)/100)
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
