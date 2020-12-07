import assert from 'assert';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {exec} from '@actions/exec';
import pkgSize from '@pvtnbr/pkg-size';
import fs from 'fs';
import path from 'path';
import log from './log';
import upsertComment from './upsert-comment';
import generateComment from './generate-comment';
import {sub} from './markdown-utils';
import {rmRF} from '@actions/io';
// import {createTempDirectory} from '@actions/cache/lib/internal/cacheUtils';

const COMMENT_SIGNATURE = sub('🤖 This report was automatically generated by [pkg-size-action](https://github.com/privatenumber/pkg-size-action/)');

// TODO: make sure this will work with empty commits or reverted changes
// TODO: make sure this doesnt consider unstaged files
async function isBaseDiffFromHead(baseRef) {
	try {
		await exec(`git fetch origin ${baseRef} --depth=1`);
	} catch (error) {
		log(`Failed to git fetch ${baseRef}`, error.message);
	}

	try {
		await exec(`git diff --name-only origin/${baseRef}`);
		await exec(`git diff --quiet origin/${baseRef}`);
		return false;
	} catch {
		return true;
	}
}

async function npmCi({cwd}) {
	if (fs.existsSync('node_modules')) {
		log('Cleaning node_modules');
		await rmRF(path.join(cwd, 'node_modules'));
	}

	if (fs.existsSync('package-lock.json')) {
		log('Installing dependencies with npm');
		return await exec('npm ci', null, {cwd});
	}

	if (fs.existsSync('pnpm-lock.yaml')) {
		log('Installing dependencies with pnpm');
		return await exec('npx pnpm i --frozen-lockfile', null, {cwd});
	}

	if (fs.existsSync('yarn.lock')) {
		log('Installing dependencies with yarn');
		return await exec('npx yarn install --frozen-lockfile', null, {cwd});
	}

	log('No lock file detected. Installing dependencies with npm');
	return await exec('npm i', null, {cwd});
}

async function buildRef({
	ref,
	buildCommand,
}) {
	const cwd = process.cwd();

	log('Current working directory', cwd);

	if (ref) {
		// const temporaryDir = await createTempDirectory();
		log(`Checking out ref '${ref}'`);
		await exec(`git checkout -f ${ref}`);
		/*
		 * For parallel builds
		 * Since this doesn't make it a git repo, installing some deps like husky fails
		 */
		// await exec(`git --work-tree="${temporaryDir}" checkout -f origin/${ref} -- .`);

		// cwd = temporaryDir;
		// log('Changed working directory', cwd);
	}

	if (buildCommand !== 'false') {
		if (!buildCommand) {
			// Check if package.json has npm run build
			let pkgJson;
			try {
				pkgJson = JSON.parse(fs.readFileSync('./package.json'));
			} catch (error) {
				log('Error reading package.json', error);
			}

			if (pkgJson && pkgJson.scripts && pkgJson.scripts.build) {
				log('Build script detected in package.json');
				buildCommand = 'npm run build';
			}
		}

		if (buildCommand) {
			await npmCi({cwd}).catch(error => {
				throw new Error(`Failed to install dependencies:\n${error.message}`);
			});

			log('Running build command', buildCommand);
			await exec(buildCommand, null, {cwd}).catch(error => {
				throw new Error(`Failed to run build command: ${buildCommand}\n${error.message}`);
			});
		}
	}

	log('Getting package size');
	const sizeData = await pkgSize(cwd).catch(error => {
		throw new Error(`Failed to determine package size: ${error.message}`);
	});

	// Clean up
	await exec('git reset --hard');

	return sizeData;
}

(async () => {
	const {GITHUB_TOKEN} = process.env;
	assert(GITHUB_TOKEN, 'Environment variable "GITHUB_TOKEN" not set. Required for accessing and reporting on the PR.');

	const {pull_request: pr} = github.context.payload;
	const buildCommand = core.getInput('build-command');
	const commentReport = core.getInput('comment-report');
	const unchangedFiles = core.getInput('unchanged-files') || 'collapse';
	const sortBy = core.getInput('sort-by') || 'delta';
	const sortOrder = core.getInput('sort-order') || 'desc';

	log('options', {
		buildCommand,
		unchangedFiles,
	});

	const headSizeData = await buildRef({
		buildCommand,
	});
	headSizeData.ref = pr.head;

	const {ref: baseRef} = pr.base;
	let baseSizeData;
	if (await isBaseDiffFromHead(baseRef)) {
		log('Head is different from base. Triggering build.');
		baseSizeData = await buildRef({
			ref: baseRef,
			buildCommand,
		});
		baseSizeData.ref = pr.base;
	} else {
		log('Head is identical to base. No need to build.');
		baseSizeData = {
			...headSizeData,
			ref: pr.base,
		};
	}

	core.setOutput('headSizeData', headSizeData);
	core.setOutput('baseSizeData', baseSizeData);

	if (commentReport !== 'false') {
		await upsertComment({
			token: GITHUB_TOKEN,
			commentSignature: COMMENT_SIGNATURE,
			repo: github.context.repo,
			prNumber: pr.number,
			body: generateComment({
				commentSignature: COMMENT_SIGNATURE,
				unchangedFiles,
				sortBy,
				sortOrder,
				baseSizeData,
				headSizeData,
			}),
		});
	}
})().catch(error => {
	core.setFailed(error.message);
});