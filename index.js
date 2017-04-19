var request = require('request');
var storage = require('node-persist');
var fuzzy = require('fuzzy');
var simpleGit = require('simple-git')

process.stdin.resume();
process.stdin.setEncoding('utf8');
var util = require('util')

var apiToken;
var repoLocation, repoBranch;
var pivotalProjectId;

var message;
var user;
var forceSelect;

function setPivotalProjectId(finished) {
	process.stdin.on('data', function (text) {
		text = text.trim();
		
		pivotalProjectId = text;
		storage.setItemSync("pivotal-project-id", pivotalProjectId);
		
		finished();
		process.exit();
	});
}

function setApiToken(finished) {
	process.stdin.on('data', function (text) {
		text = text.trim();
		
		apiToken = text;
		storage.setItemSync("api-token", apiToken);
		
		finished();
		process.exit();
	});
}

function setRepoLocation(finished) {
	process.stdin.on('data', function (text) {
		text = text.trim();
		
		repoLocation = text;
		storage.setItemSync("repo-location", repoLocation);
		
		finished();
		process.exit();
	});
}

function getUser(args) {
	var getOptions = {
		url: 'https://www.pivotaltracker.com/services/v5/me',
	    method: 'GET',
		headers: {
			'X-TrackerToken': apiToken
		}
	};
	
	request(getOptions, function (error, response, body) {
		if (error) {
			console.log('error:', error); // Print the error if one occurred
			
			process.exit(1);
		} else {
			user = JSON.parse(body);
			
			args.success(user);
			
			return user;
		}
		
		args.failure();
	});
}

function processStories() {
	var getOptions = {
		url: 'https://www.pivotaltracker.com/services/v5/projects/' + pivotalProjectId + '/stories?limit=100&offset=0&with_state=started',
	    method: 'GET',
		headers: {
			'X-TrackerToken': apiToken
		}
	};
	
	request(getOptions, function (error, response, body) {
		if (error) {
			console.log('error:', error); // Print the error if one occurred
			
			process.exit(1);
		} else {
			stories = JSON.parse(body);
			
			stories = stories.filter(function (story) {
				return story.owner_ids.find(function (s) {
					return s == user.id;
				})
			});
			
			if (stories.length > 1) {
				var storedId = storage.getItemSync('current-story-id');
				
				if (!forceSelect && storedId) {
					var story = stories.find(function (story) {
						return story.id == storedId;
					});
					
					if (story) {
						commitToStory(story);
						return;
					} else {
						storage.setItemSync('current-story-id', undefined);
					}
				}
				
				console.log("Choose between (type in fuzzy name or id):\n" + stories.map(function (story) {
					return story.id + ": " + story.name;
				}).join("\n"));
				
				var search = stories.map(function (story) {
					return story.id + " " + story.name;
				});
				
				function selectStory(finished) {
					process.stdin.on('data', function (text) {
						text = text.substring(0, text.length - 1);
						var filtered = fuzzy.filter(text, search);
					
						if (filtered.length > 1) {
							console.log("\"" + text + "\" ambiguous between:\n" + filtered.map(function (story) {
								return story.string;
							}).join("\n") + "\ntry again");
							
							selectStory();
						} else if (filtered.length == 0) {
							console.log("No results for \"" + text + "\", try again");
							
							selectStory();
						} else {
							var id = filtered[0].string.substring(0, filtered[0].string.indexOf(' '));
							
							finished(stories.find(function (story) {
								return story.id == id;
							}));
							process.exit();
						}
					});
				}
				
				selectStory(function (story) {
					storage.setItemSync('current-story-id', story.id);
					
					commitToStory(story);
				});
			} else if (stories.length == 0) {
				console.log("You do not have any stories started")
			} else {
				commitToStory(stories[0]);
			}
		}
	});
}

function commitToStory(story) {
	var prefix = "[#" + story.id + "] ";
	
	console.log("Committing to story: " + story.name);
	console.log(prefix + message);
	
	function filterAdded(files) {
		return files.filter(function (f) {
			return f.index == 'M';
		});
	}
	
	var status, commits;
	
	var repo = simpleGit(repoLocation);
	
	
		repo.status(function (err, s) {
			console.log(s);
			
			status = s;
			
			if (filterAdded(s.files).length == 0) {
				console.log("!!! no files are added");
				// process.exit(1);
			}
		}).log(function (err, s) {
			commits = s.all.slice(0, status.tracking ? status.ahead : s.all.length);
			// if (filterAdded(s.files).length == 0) {
			// 	console.log("!!! no files are added");
			// 	process.exit(1);
			// }
			
			var message = commits[0].message;
			
			if (message[message.length - 1] == ')') {
				commits[0].message = message.substring(0, message.lastIndexOf('(') - 1);
			}
		}).then(function () {
			var tempBranchName = "pivotalTemp" + new Date().getTime();
			
			function finished() {
				// repo.raw(["branch", "-d", tempBranchName], function (e, r) {
					process.exit();
				// });
			}
			
			function amendCommit(commit) {
				repo.raw(["branch"], function (e, r) {
					var branchName = r.substring(2).trim();
					
					console.log("Got branch");
			
					repo.raw(["checkout", commit.hash], function (e, r) {
						console.log("checked out: ", r);
						repo.raw(["commit", "--amend", "-m", prefix + commit.message], function (e, r) {
							console.log("Committed: ", r);
							repo.log(function (e, r) {
								console.log("logged: ", r);
								repo.raw(["replace", commit.hash, r.latest.hash], function (e, r) {
									console.log("replaced: ", r);
									repo.raw(["filter-branch", "-f", "--", "--all"], function (e, r) {
										console.log("filtered: ", r);
										repo.raw(["replace", "-d", commit.hash], function (e, r) {
											console.log("replaced: ", r);
											repo.raw(["checkout", branchName], function (e, r) {
												console.log("checed out : ", r);
											// repo.raw(["checkout", "-b", tempBranchName], function (e, r) {
											// 	repo.raw(["branch", "-f", branchName, tempBranchName], function (e, r) {
													if (commits.length == 0) {
														finished();
													} else {
														amendCommit(commits.shift());
													}
												});
											// })
										});
									});
								});
							});
						});
					});
				});
			}
			
			amendCommit(commits.shift());
		})
}

// INITIALIZATION:

var argSkipCount = 0;

function deploy() {
	
}

function help() {
	console.log("pvc [\"commit message (don't include pivotal id)\"] [-deploy] [--api-token 12123k12k12jknnk21kn21n12] [-reselect] [--repo-location /repo/root/url] [--pivotal-project-id 1234511]");
	process.exit(0);
}

function printOrContinue(index, type) {
	if (index == process.argv.length - 1) {
		console.log(type + ": " + storage.getItemSync(type));
		
		process.exit();
	}
}

storage.initSync();

process.argv.forEach(function (val, index, array) {
	if (argSkipCount > 0) {
		argSkipCount--;
		return;
	}
	
	if (index >= 2) {
		if (val.indexOf("-") == 0) {
			var arg = val.substring(1).toLowerCase();
			
			switch (arg) {
				case "deploy":
					deploy();
					break;
				case "-api-token":
					printOrContinue(index, "api-token");
					argSkipCount = 1;
					apiToken = process.argv[index + 1];
					storage.setItemSync("api-token", apiToken);
					break;
				case "reselect":
					forceSelect = true;
					break;
				case "-repo-location":
					printOrContinue(index, "repo-location");
					argSkipCount = 1;
					repoLocation = process.argv[index + 1];
					storage.setItemSync("repo-location", repoLocation);
					break;
				case "-repo-branch":
					printOrContinue(index, "repo-branch");
					argSkipCount = 1;
					repoBranch = parseBranch(process.argv[index + 1]);
					storage.setItemSync("repo-branch", repoBranch);
					break;
				case "-pivotal-project-id":
					printOrContinue(index, "pivotal-project-id");
					argSkipCount = 1;
					pivotalProjectId = parseBranch(process.argv[index + 1]);
					storage.setItemSync("pivotal-project-id", pivotalProjectId);
					break;
				case "h": case "help":
					help();
					break;
				default: {
					console.error("Invalid argument: " + val);
					process.exit(1);
				}
			}
		} else if (val == "?") {
			help();
		} else if (!message) {
			message = val;
		} else {
			console.error("Invalid argument: " + val);
			process.exit(1);
		}
	}
});

if (argSkipCount > 0) {
	console.error("Missing value for argument: " + process.argv[process.argv.length - 1]);
	process.exit(1);
}

function loadValues() {
	pivotalProjectId = pivotalProjectId || storage.getItemSync('pivotal-project-id');
	apiToken = apiToken || storage.getItemSync('api-token');
	repoLocation = repoLocation || storage.getItemSync('repo-location');
	repoBranch = repoBranch || storage.getItemSync('repo-branch');

	function recurse() {
		loadValues();
		run();
	}

	if (!pivotalProjectId) {
		console.log("You must set your pivotal project id!!!!!!! please enter it here:");
		
		setPivotalProjectId(recurse);
	} else if (!apiToken) {
		console.log("You must set your user api key!!!!!!! please enter it here:");
		
		setApiToken(recurse);
	} else if (!repoLocation) {
		console.log("You must set your repo location!!!!!!! please enter it here:");
		
		setRepoLocation(recurse);
	} /*else if (!repoBranch) {
		console.log("You must set your repo branch!!!!!!! please enter it here:");
		
		setRepoBranch(recurse);
	}*/ else {
		run();
	}
}

loadValues();

function run() {
	getUser({
		success: processStories,
		failure: function () {
			console.error("You are not logged in... may need to reset api key");
			process.exit(1);
		}
	});
}