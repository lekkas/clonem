var spawn = require('child_process').spawn;
var path = require('path');
var fs = require('fs');

var parse = require('parse-link-header');
var request = require('request');
var async = require('async');
var _ = require('lodash');

var config = require('./config');

(function () {
  var arg = process.argv.slice(2)[0] || '';
  if (!arg) {
    console.log("Usage: node app.js [user|organization]");
    process.exit(1);
  }

  var activeChild;

  process.on('SIGINT', function() {
    if (activeChild) {
      console.log('Aborting '+activeChild.full_name);
      activeChild.kill('SIGKILL');
      activeChild = null;
    }
  });
  // Signal handler for Ctrl - C

  function getNextRepoPage(repoPage, repoPageList, callback) {
    baseRequest.get(repoPage, function(error, resp, body) {
      if (error || resp.statusCode != 200) {
        return callback(error);
      }

      if (!resp.headers.link)
        return callback(null, repoPageList);

      var parsed = parse(resp.headers.link);
      if (parsed.next && parsed.next.url) {
        repoPage = parsed.next.url;
        repoPageList.push(repoPage);

        // Prevent the stack from overflowing, though
        // unlikely, since we don't expect a large
        // number of github repository pagination
        // results. Just playing with node here.
        async.nextTick(function() {
          getNextRepoPage(repoPage, repoPageList, callback);
        });
      } else {
          callback(null, repoPageList);
      }
    });
  }

  function getRepos(repoPage, repoList, callback) {
    baseRequest.get(repoPage, function(error, resp, body) {
      if (error || resp.statusCode != 200) {
        return callback(error);
      }

      body = JSON.parse(body);
      var repoPartialList = body.map(function(repo) {
        return {
          full_name: repo.full_name,
          clone_url: repo.clone_url,
          size: repo.size
        };
      });

      repoPartialList.forEach(function(repo) {
        repoList.push(repo);
      });

      callback();
    });
  }

  function cloneRepo(repo) {
    return function(callback) {
      var opts = {
        stdio: [
          'pipe', // pipe child's stdin to parent
          1, // stdout
          2 // stderr
        ]
      };

      var args = [
        'clone',
        repo.clone_url,
        repo.full_name
      ];

      var child = spawn('git', args, opts);
      child.full_name = repo.full_name;
      activeChild = child;

      child.on('close', function(code) {
        if (code) {
          return callback(new Error('git ' + args + ' failed'));
        }
        callback(null);
      });
      child.on('error', function(err) {
        if (err) {
          return callback(err);
        }
      });
    };
  }



  var baseUrl = 'https://api.github.com';
  var baseRequest = request.defaults({
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'lekkas/repo-fetch',
      'Authorization': 'token ' + config.token
    }
  });

  // Populate 'repoPageList' with list of repository pages
  async.waterfall([

      // Get repository Pages
      function(callback) {
        var repoPageList = [];
        var repoPage = baseUrl + '/users/' + arg + '/repos';
        repoPageList.push(repoPage);
        getNextRepoPage(repoPage, repoPageList, callback);
      },

      // Get repository clone URLs
      function(repoPageList, callback) {
        var repoList = [];
        async.each(repoPageList, function (repoPage, cb) {
            getRepos(repoPage, repoList, cb);
          },
          function (err) {
            if (err) {
              console.log('Error: '+err);
              process.exit(2);
            }
            callback(null, repoList);
        });
      },

      // Clone repositories
      // TODO: add option to update repos
      function(repoList, callback) {
        var cloneTasks = [];
        var cloneList = [];

        async.filter(repoList, function(repo, cb) {
          var dir = path.join(process.cwd(), repo.full_name);
          fs.stat(dir, function(err, stats) {

            // TODO: check if directory is working git repo
            // TODO: check if directory is empty; if so, continue
            // TODO: Use colors (chalk)
            // with cloning
            if (stats !== undefined) {
              console.log(repo.full_name + ' directory already exists');
              cb(false);
            } else {
              cb(true);
            }
          });
        },
        function(cloneList) {
          cloneList.forEach(function(repo) {
            cloneTasks.push(cloneRepo(repo));
          });

          async.series(cloneTasks, function(err) {
            if (err) {
              console.log(err);
            }
            callback(null);
          });

        });
      }
    ], function (err) {
        if (err) {
          console.log('Error: '+err);
          process.exit(2);
        }
  });
})();
