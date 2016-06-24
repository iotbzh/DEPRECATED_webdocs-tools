// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

"use strict";

var fs            = require("fs");
var fse           = require("fs-extra");
var https         = require("https");
var path          = require("path");
var child_process = require("child_process");
var yaml          = require("js-yaml");
var config;
var util = require("../lib/util");

var THIS_FILE       = path.basename(__filename);
var WARNING_COMMENT = "<!-- WARNING: This file is generated. See " + THIS_FILE + ". -->\n\n";

// helpers
function isPluginName(packageName) {
    return packageName.match(/cordova-plugin-.*/);
}


function getRepoFileURI(repoName, commit, filePath) {
    return config.REPO_FETCH + repoName + "/" + commit + "/" + filePath;
}

function getRepoEditURI(repoName, commit, filePath) {
    return config.REPO_EDIT + repoName + "/blob/" + commit + "/"+ filePath;
}

function packageNameFromRepoName(repoName) {
    var repoSplit      = repoName.split('/');
    var repoOwner      = repoSplit[0];
    var actualRepoName = repoSplit[1];
    return actualRepoName;
}

function getFetchedFileConfig(entry) {

    // get entry components
    var srcConfig  = entry.src;
    var destConfig = entry.dest;

    // validate entry
    if (!srcConfig) {
        console.error("entry '" + entry.toString() + "' missing 'src'");
        return;
    }

    if (!srcConfig.repoName) {
        console.error("entry '" + entry.toString() + "' missing 'repoName' in 'src'");
        return;
    }

    if (!srcConfig.repoName) {
        console.error("entry '" + entry.toString() + "' missing 'repoName' in 'src'");
        return;
    }

    if (!destConfig) {
        console.error("entry '" + entry.toString() + "' missing 'dest'");
        return;
    }

    if (!destConfig.path) {
        console.error("entry '" + entry.toString() + "' missing 'path' in 'dest'");
        return;
    }

    // complete src config
    if (!srcConfig.packageName) {
        srcConfig.packageName = packageNameFromRepoName(srcConfig.repoName);
    }

    if (!srcConfig.path) {
        srcConfig.path = config.DEFAULT_GIT_DOC;
    }

    if (!srcConfig.commit) {
        srcConfig.commit = getLatestRelease(srcConfig.packageName);
    }

    // make front matter
    var frontMatter = {
        edit_link: getRepoEditURI(srcConfig.repoName, srcConfig.commit, srcConfig.path),
        title:     srcConfig.packageName
    };

    // set special front matter values for plugins
    if (isPluginName(srcConfig.packageName)) {
        frontMatter.plugin_name    = srcConfig.packageName;
        frontMatter.plugin_version = srcConfig.commit;
    }

    // set returned values
    var fetchedFileConfig = {
        frontMatter: frontMatter,
        downloadURI: getRepoFileURI(srcConfig.repoName, srcConfig.commit, srcConfig.path),
        savePath:    destConfig.path
    };
    
    return fetchedFileConfig;
}

function getFrontMatter(text) {
    var frontMatterString = util.getFrontMatterString(text);
    if (frontMatterString !== null) {
        return yaml.load(frontMatterString);
    }
    return {};
}

function setFrontMatter(text, frontMatter, options) {
    var frontMatterString = yaml.dump(frontMatter, options);
    return util.setFrontMatterString(text, frontMatterString);
}

function dumpEntries(downloadPrefix, entries) {
    entries.forEach(function (entry) {

        // validate entry's dest config
        if (!entry.dest) {
            console.error("entry '" + entry.toString() + "' missing 'dest'");
            return;
        }

        if (!entry.dest.path) {
            console.error("entry '" + entry.toString() + "' missing 'path' in 'dest'");
            return;
        }

        // print the save path for the entry
        if (entry.dest && entry.dest.path) {
            var filePath = path.join(downloadPrefix, entry.dest.path);

        // error out on invalid entries
        } else {
            console.error("Invalid dest: " + entry);
            process.exit(1);
        }
    });
}

function downloadEntries(downloadPrefix, entries) {
    
    entries.forEach(function (entry) {

        // verify and process entry
        var fetchedFileConfig = getFetchedFileConfig(entry);
        if (!fetchedFileConfig) {
            console.log ("hoop: no entry in FETCH_CONFIG+[%s]", config.FETCH_CONFIG);
            process.exit(1);
        }
        
        // get info for fetching
        var fetchURI    = fetchedFileConfig.downloadURI;
        var outFilePath = path.join(downloadPrefix, fetchedFileConfig.savePath);
        var outFileDir  = path.dirname(outFilePath);
        
        // create directory for the file if it doesn't exist
        if (!fs.existsSync(outFileDir)) {
            fse.mkdirsSync(outFileDir);
        }

        // open the file for writing
        var outFile = fs.createWriteStream(outFilePath);

        // open an HTTP request for the file
        var request = https.get(fetchURI, function (response) {

            if (response.statusCode !== 200) {
                console.error("Failed to download " + fetchURI + ": got " + response.statusCode);
                process.exit(1);
            }

            // read in the response
            var fileContents = '';
            response.setEncoding('utf8');
            response.on('data', function (data) {
                fileContents += data;
            });

            // process the response when it finishes
            response.on('end', function () {

                // merge new front matter and file's own front matter (if it had any)
                //
                // NOTE:
                //      fileFrontMatter's properties should override those of newFrontMatter
                var newFrontMatter    = fetchedFileConfig.frontMatter;
                var fileFrontMatter   = getFrontMatter(fileContents);
                var mergedFrontMatter = util.mergeObjects(newFrontMatter, fileFrontMatter);

                // add a warning and set the merged file matter in the file
                var contentsOnly = util.stripFrontMatter(fileContents);
                contentsOnly     = WARNING_COMMENT + contentsOnly;

                var augmentedContents = setFrontMatter(contentsOnly, mergedFrontMatter);

                // write out the file
                outFile.end(augmentedContents);

            }).on('error', function(e) {
                console.error(e);
            });
        }); // http request
    }); // entries
}

// main
function FetchFiles (argv, item, fetchconf, version) {
    
    var targetVersion  = config.VERSION_TAGDEV;
    var targetLanguage = config.LANG_DEFAULT;
    var destination    = path.join (config.DOCS_DIR, item, targetLanguage, targetVersion, config.FETCH_DIR);
    
    // if destination directory does not exist create it 
    if (!fs.existsSync(destination)) fs.mkdirSync(destination);
    else {
        if (!argv.force) {
            console.log ("  * WARNING: use [--force/--clean] to overload Fetchdir [%s]", destination);
            return;
        } else {
            console.log ("  * WARNING: overloaded Fetchdir [%s]", destination);
        }
    }

    if (argv.verbose) {
        console.log ("  + FetchConfig = [%s]", fetchconf);
        console.log ("  + Destination = [%s]", destination);
    }

    // get config
    var fetchConfig   = fs.readFileSync(fetchconf);
    var configEntries = yaml.load(fetchConfig);
    
    // just dump entries if --dump was passed
    if (argv.dumponly) dumpEntries(destination, configEntries);
    else downloadEntries(destination, configEntries);
    
}

function main (conf, argv) {

    config = conf;  // make config global 

    // open destination _default.yml file
    var destdir = path.join (config.DATA_DIR, "tocs");
    if(!fs.existsSync(destdir)) fs.mkdirSync(destdir);

    var tocs = fs.readdirSync(config.TOCS_DIR);
    for (var item in tocs) {
        var tocDir   = path.join (config.TOCS_DIR, tocs[item]);
        var fetchconf= path.join (config.TOCS_DIR, tocs[item], config.FETCH_CONFIG);
        var version  = path.join (config.TOCS_DIR, tocs[item], config.VERSION_LASTEST);
        
        if (fs.existsSync(fetchconf) && fs.existsSync(version)) {
            FetchFiles (argv, tocs[item], fetchconf, version);
        }
    }
    if (argv.verbose) console.log ("  + fetch_docs done");

}


// if started as a main and not as module, then process test.
if (process.argv[1] === __filename) {
    var config= require("../lib/_Config")("docs");
    var argv = require('minimist')(process.argv.slice(2));
    main(config, argv);
}

module.exports = main;