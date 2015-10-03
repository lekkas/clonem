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

  /* Signal handler for Ctrl-C
   *
   * Aborts download of current github repository
   */
  process.on('SIGINT', function() {
    if (activeChild) {
      console.log('Aborting '+activeChild.full_name);
      activeChild.kill('SIGKILL');
      activeChild = null;
    }
  });

  /*
   * Get next repository page. When github repositories of a user/org
   * are more than a certain threshold, Github paginates the repository
   * list.
   *
   * @param repoPageURL The URL of a repository page. Normally this will be the
   * first one, i.e. https://api.github.com/users/:user/repos . The function
   * will then recursively append all next repository pages, if they exist, to
   * the repoPages list.
   * @param repoPages A list containing all repository page URL's
   * @callback Callback to call when all repository pages have been retrieved
   */
  function getNextRepoPage(repoPageURL, repoPages, callback) {
    baseRequest.get(repoPageURL, function(error, resp, body) {
      if (error || resp.statusCode != 200) {
        return callback(error);
      }

      if (!resp.headers.link)
        return callback(null, repoPages);

      var parsed = parse(resp.headers.link);
      if (parsed.next && parsed.next.url) {
        var nextRepoPageURL = parsed.next.url;
        repoPages.push(nextRepoPageURL);

        /*
         * Prevent the stack from overflowing while we are recursing,
         * though this is unlikely to happen, since we don't expect
         * a large number of github repository pagination
         * results. Just playing with node here.
         */
        async.nextTick(function() {
          getNextRepoPage(nextRepoPageURL, repoPages, callback);
        });
      } else {
          callback(null, repoPages);
      }
    });
  }

  /*
   * Get full name, clone url and size of repository.
   *
   * @param repoPageURL The URL of repository page
   * @param repos List of repository info objects:
   * {
   *  full_name: 'user/repo',
   *  clone_url: 'URL',
   *  size: 0
   * }
   * @param callback Callback to signal that repository info objects of for current page
   * have been added to the list
   */
  function getRepos(repoPageURL, repos, callback) {
    baseRequest.get(repoPageURL, function(error, resp, body) {
      if (error || resp.statusCode != 200) {
        return callback(error);
      }

      body = JSON.parse(body);
      var currentPageRepos = body.map(function(repo) {
        return {
          full_name: repo.full_name,
          clone_url: repo.clone_url,
          size: repo.size
        };
      });

      currentPageRepos.forEach(function(repo) {
        repos.push(repo);
      });

      callback();
    });
  }

  /*
   * Clone git repository, given a clone url.
   *
   * @param repoInfo The repository info object
   * {
   *  full_name: 'user/repo',
   *  clone_url: 'URL',
   *  size: 0
   * }
   *
   * cloneRepo() will clone repo at location 'clone_url' into folder 'full_name'
   */
  function cloneRepo(repoInfo) {
    return function(callback) {
      var opts = {
        stdio: [
          'pipe', // pipe child's stdin to parent
          1,      // use parent's stdout
          2       // use parent's stderr
        ]
      };

      var args = [
        'clone',
        repoInfo.clone_url,
        repoInfo.full_name
      ];

      var child = spawn('git', args, opts);
      child.full_name = repoInfo.full_name;
      activeChild = child;

      child.on('close', function(code) {
        if (code) {
          return callback(new Error('git ' + args[0] + ' ' + args[1] + ' failed'));
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

      /*
       * Waterfall 1: Get URLs of all repository pages
       */
      function(callback) {
        var repoPageList = [];
        var repoPage = baseUrl + '/users/' + arg + '/repos';
        repoPageList.push(repoPage);
        getNextRepoPage(repoPage, repoPageList, callback);
      },

      /*
       * Waterfall 2: Get repository clone URLs
       */
      function(repoPageList, callback) {
        var repoList = [];

        // TODO: Is nesting 'async' module calls considered an antipattern?
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

      /*
       * Waterfall 3: Clone repositories
       * TODO: add option to update repos
       */
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
        }
  });
})();
