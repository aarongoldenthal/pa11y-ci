//
// This is the main library code for Pa11y CI. It's
// in charge of taking some URLs and configuration,
// then managing a queue of Pa11y jobs.
//
'use strict';

const defaults = require('lodash/defaultsDeep');
const omit = require('lodash/omit');
const pa11y = require('pa11y');
const queue = require('async/queue');
const puppeteer = require('puppeteer');
const resolveReporters = require('./helpers/resolver');
const defaultCfg = require('./helpers/defaults');


// Here's the exports. `pa11yCi` is defined further down the
// file and is the function that actually starts to do things
module.exports = pa11yCi;


function cycleReporters(reporters, method, ...args) {
	if (!reporters.length) {
		return Promise.resolve();
	}
	return Promise.all(reporters.map(reporter => {
		if (typeof reporter[method] === 'function') {
			return reporter[method](...args);
		}
		return false;
	}));
}

// The default configuration object. This is extended with
// whatever configurations the user passes in from the
// command line
module.exports.defaults = defaultCfg;

// This function does all the setup and actually runs Pa11y
// against the passed in URLs. It accepts options in the form
// of an object and returns a Promise
function pa11yCi(urls, options) {
	// eslint-disable-next-line no-async-promise-executor, max-statements
	return new Promise(async resolve => {
		// Create a test browser to assign to tests
		let testBrowser;

		// Issue #128: on specific URLs, Chrome will sometimes fail to load
		//  the page, or crash during or after loading. This attempts to
		//  relaunch the browser just once before bailing out, in case Chrome
		//  crashed at startup. This is just an attempt at mitigating it,
		//  it won't fix #128 completely or even at all
		try {
			testBrowser = await puppeteer.launch(
				options.chromeLaunchConfig
			);
		} catch (error) {
			testBrowser = await puppeteer.launch(
				options.chromeLaunchConfig
			);
		}

		// Default the passed in options
		options = defaults({}, options, module.exports.defaults);

		// Resolve reporters
		const reporters = resolveReporters(options);

		// We delete options.log because we don't want it to
		// get passed into Pa11y – we don't want super verbose
		// logs from it
		// we also remove reporters because it's not part of pa11y options
		options = omit(options, ['log', 'reporters']);

		await cycleReporters(reporters, 'beforeAll', urls);

		// Create a Pa11y test function and an async queue
		const taskQueue = queue(testRunner, options.concurrency);
		taskQueue.drain = testRunComplete;

		// Push the URLs on to the queue
		taskQueue.push(urls);

		// The report object is what we eventually return to
		// the user or command line runner
		const report = {
			total: urls.length,
			passes: 0,
			errors: 0,
			results: {}
		};

		// Map of duplicate URLs to track counts
		const duplicateUrls = new Map();

		// Common function to save results to encapsulate duplicate URL
		// processing logic, which will append the count to the URL so
		// it is saved.
		function saveResults(url, results) {
			let formattedUrl;
			if (Object.keys(report.results).includes(url)) {
				// If results exist for this URL, update the duplicate
				// count and append to the URL.
				const currentCount = duplicateUrls.get(url) || 1;
				const newCount = currentCount + 1;
				duplicateUrls.set(url, newCount);
				formattedUrl = `${url} (${newCount})`;
			} else {
				formattedUrl = url;
			}
			report.results[formattedUrl] = results;
		}

		function processResults(results, reportConfig) {
			const withinThreshold = reportConfig.threshold ?
				results.issues.length <= reportConfig.threshold :
				false;
			if (results.issues.length && !withinThreshold) {
				saveResults(results.pageUrl, results.issues);
				report.errors += results.issues.length;
			} else {
				saveResults(results.pageUrl, []);
				report.passes += 1;
			}
		}

		// This is the actual test runner, which the queue will
		// execute on each of the URLs
		// eslint-disable-next-line max-statements
		async function testRunner(config) {
			let url;
			if (typeof config === 'string') {
				url = config;
				config = options;
			} else {
				url = config.url;
				config = defaults({}, config, options);
			}

			await cycleReporters(reporters, 'begin', url);

			config.browser = config.useIncognitoBrowserContext ?
				await testBrowser.createIncognitoBrowserContext() :
				testBrowser;

			// Run the Pa11y test on the current URL and add
			// results to the report object
			try {
				const results = await pa11y(url, config);
				await cycleReporters(reporters, 'results', results, config);
				processResults(results, config);
			} catch (error) {
				await cycleReporters(reporters, 'error', error, url, config);
				saveResults(url, [error]);
			} finally {
				if (config.useIncognitoBrowserContext) {
					await config.browser.close();
				}
			}
		}

		// This function is called once all of the URLs in the
		// queue have been tested. It outputs the actual errors
		// that occurred in the test as well as a pass/fail ratio
		function testRunComplete() {
			testBrowser.close();

			// Resolve the promise with the report
			cycleReporters(reporters, 'afterAll', report, options).then(() => resolve(report));
		}

	});
}
