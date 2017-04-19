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

function setApiToken(finished) {
	process.stdin.on('data', function (text) {
		text = text.trim();
		
		apiToken = text;
		storage.setItemSync("api-token", apiToken);
		
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
		url: 'https://www.pivotaltracker.com/services/v5/projects/1551625/stories?limit=100&offset=0&with_state=started',
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
						process.exit();
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
	console.log("Committing to story: " + story.name);
	console.log("[#" + story.id + "] " + message);
	
	function filterAdded(files) {
		return files.filter(function (f) {
			return f.index == 'M';
		});
	}
	
	simpleGit(repoLocation)
		.status(function (err, s) {
			console.log(s);
			if (filterAdded(s.files).length == 0) {
				// console.log("!!! no files are added");
				// process.exit(1);
			}
		}).log(function (err, s) {
			console.log(s.latest);
			// if (filterAdded(s.files).length == 0) {
			// 	console.log("!!! no files are added");
			// 	process.exit(1);
			// }
		}).then(function () {
			console.log("Successfully committed");
			process.exit();
		})
}

// INITIALIZATION:

var argSkipCount = 0;

function deploy() {
	
}

function help() {
	console.log("pvc [\"commit message (don't include pivotal id)\"] [-deploy] [--api-token 12123k12k12jknnk21kn21n12] [-reselect]");
	process.exit(0);
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
					argSkipCount = 1;
					apiToken = process.argv[index + 1];
					storage.setItemSync("api-token", apiToken);
					break;
				case "reselect":
					forceSelect = true;
					break;
				case "-request-limit":
					argSkipCount = 1;
					requestLimit = parseInt(process.argv[index + 1]);
					break;
				case "offset":
					argSkipCount = 1;
					pageOffset = parseInt(process.argv[index + 1]);
					break;
				case "filter":
					argSkipCount = 1;
					filterStories = process.argv[index + 1] == "true";
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