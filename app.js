var request = require('request');
var config = require('./config');
var _ = require('lodash');
var parse = require('parse-link-header');
var async = require('async');

var arg = process.argv.slice(2)[0] || '';
if (!arg) {
  console.log("Usage: node app.js [user|organization]");
  process.exit(1);
}

var baseUrl = 'https://api.github.com';

var baseRequest = request.defaults({
  headers: {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'lekkas/repo-fetch',
    'Authorization': 'token ' + config.token
  }
});

function fetchRepoURLs(repoURL, repoList, callback) {
    baseRequest.get(repoURL, function(error, resp, body) {
      if (error || resp.statusCode != 200) {
        console.log('Repo request error: ' + error);
        process.exit(2);
      }

      if (resp.headers.link) {
        var parsed = parse(resp.headers.link);
        if (parsed.next && parsed.next.url) {
          var repo = parsed.next.url;
          repoList.push(repo);
          fetchRepoURLs(repo, repoList, callback);
        } else {
          callback(null, repoList);
        }
      }
    });
}

var repoURLs = [];

async.waterfall([
    function(callback) {
      baseRequest.get(baseUrl + '/users/' + arg, function(error, response, body) {
        if (error || response.statusCode != 200) {
          callback(err);
        }

        var repoURLs = [];

        body = JSON.parse(response.body);
        if (!body.repos_url)
          return;

        var repo = body.repos_url || '';
        if (repo) {
          callback(null, repo);
        } else {
          callback(new Error("No repositories for '"+arg+"'"));
        }
      });
    },
    function(arg1, callback) {
      repoURLs.push(arg1);
      fetchRepoURLs(arg1, repoURLs, callback);
    }
], function (err, repoURLs) {
  if (err) {
    console.log('Error: ' + err);
    process.exit(2);
  }

  console.log('Repo urls: ');
  _.forEach(repoURLs, function(r) {
    console.log(r);
  });
});
