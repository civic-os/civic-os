#!/usr/bin/env node
/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2));
