//
// This is the main library code for Pa11y CI. It's
// in charge of taking some URLs and configuration,
// then managing a queue of Pa11y jobs.
//
'use strict';

const {cyan, green, grey, red, underline} = require('kleur');
const defaults = require('lodash/defaultsDeep');
const pa11y = require('pa11y');
const queue = require('async/queue');
const wordwrap = require('wordwrap');
const puppeteer = require('puppeteer');

// Just an empty function to use as default
// configuration and arguments
/* istanbul ignore next */
// eslint-disable-next-line no-empty-function
const noop = () => {};

// Here's the exports. `pa11yCi` is defined further down the
// file and is the function that actually starts to do things
module.exports = pa11yCi;

// The default configuration object. This is extended with
// whatever configurations the user passes in from the
// command line
module.exports.defaults = {
	concurrency: 1,
	log: {
		error: noop,
		info: noop
	},
	wrapWidth: 80,
	useIncognitoBrowserContext: true
};

// This function does all the setup and actually runs Pa11y
// against the passed in URLs. It accepts options in the form
// of an object and returns a Promise
function pa11yCi(urls, options) {
	// eslint-disable-next-line no-async-promise-executor
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

		// We delete options.log because we don't want it to
		// get passed into Pa11y – we don't want super verbose
		// logs from it
		const log = options.log;
		delete options.log;

		// Create a Pa11y test function and an async queue
		const taskQueue = queue(testRunner, options.concurrency);
		taskQueue.drain = testRunComplete;

		// Push the URLs on to the queue
		log.info(cyan(underline(`Running Pa11y on ${urls.length} URLs:`)));
		taskQueue.push(urls);

		// The report object is what we eventually return to
		// the user or command line runner
		const report = {
			total: urls.length,
			passes: 0,
			errors: 0,
			results: {}
		};

		function processResults(results, reportConfig, url) {
			const withinThreshold = reportConfig.threshold ?
				results.issues.length <= reportConfig.threshold :
				false;

			let message = ` ${cyan('>')} ${url} - `;
			if (results.issues.length && !withinThreshold) {
				message += red(`${results.issues.length} errors`);
				log.error(message);
				report.results[url] = results.issues;
				report.errors += results.issues.length;
			} else {
				message += green(`${results.issues.length} errors`);
				if (withinThreshold) {
					message += green(
						` (within threshold of ${reportConfig.threshold})`
					);
				}
				log.info(message);
				report.results[url] = [];
				report.passes += 1;
			}
		}

		// This is the actual test runner, which the queue will
		// execute on each of the URLs
		async function testRunner(config) {
			let url;
			if (typeof config === 'string') {
				url = config;
				config = options;
			} else {
				url = config.url;
				config = defaults({}, config, options);
			}
			config.browser = config.useIncognitoBrowserContext ?
				await testBrowser.createIncognitoBrowserContext() :
				testBrowser;

			// Run the Pa11y test on the current URL and add
			// results to the report object
			try {
				const results = await pa11y(url, config);
				processResults(results, config, url);
			} catch (error) {
				log.error(` ${cyan('>')} ${url} - ${red('Failed to run')}`);
				report.results[url] = [error];
			} finally {
				if (config.useIncognitoBrowserContext) {
					config.browser.close();
				}
			}
		}

		// This function is called once all of the URLs in the
		// queue have been tested. It outputs the actual errors
		// that occurred in the test as well as a pass/fail ratio
		function testRunComplete() {
			const passRatio = `${report.passes}/${report.total} URLs passed`;

			testBrowser.close();

			if (report.passes === report.total) {
				log.info(green(`\n✔ ${passRatio}`));
			} else {
				// Now we loop over the errors and output them with
				// word wrapping
				const wrap = wordwrap(3, options.wrapWidth);
				Object.keys(report.results).forEach(url => {
					if (report.results[url].length) {
						log.error(underline(`\nErrors in ${url}:`));
						report.results[url].forEach(result => {
							const redBullet = red('•');
							if (result instanceof Error) {
								log.error(`\n ${redBullet} Error: ${wrap(result.message).trim()}`);
							} else {
								const context = result.context ?
									result.context.replace(/\s+/g, ' ') :
									'[no context]';
								log.error([
									'',
									` ${redBullet} ${wrap(result.message).trim()}`,
									'',
									grey(wrap(`(${result.selector})`)),
									'',
									grey(wrap(context))
								].join('\n'));
							}
						});
					}
				});
				log.error(red(`\n✘ ${passRatio}`));
			}

			// Resolve the promise with the report
			resolve(report);
		}

	});
}
