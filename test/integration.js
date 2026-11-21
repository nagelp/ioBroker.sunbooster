"use strict";

const path = require("path");
const { tests } = require("@iobroker/testing");

// Start the adapter in a temporary js-controller instance and check that it does not crash
tests.integration(path.join(__dirname, ".."));
