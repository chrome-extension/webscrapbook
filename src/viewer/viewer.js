/********************************************************************
 *
 * Script for viewer.html
 *
 * @require {Object} scrapbook
 *******************************************************************/

let _isFxBelow56;
Promise.resolve().then(() => {
  return browser.runtime.getBrowserInfo();
}).then((info) => {
  _isFxBelow56 =
      (info.name === 'Firefox' || info.name === 'Fennec') &&
      parseInt(info.version.match(/^(\d+)\./)[1], 10) < 56;
}).catch((ex) => {
  _isFxBelow56 = false;
});

function init() {
  const fileSystemHandler = {
    /**
     * @return {Promise}
     */
    getDir(dirEntry, path) {
      return new Promise((resolve, reject) => {
        dirEntry.getDirectory(path, {}, resolve, reject);
      });
    },

    /**
     * @return {Promise}
     */
    getFile(dirEntry, path) {
      return new Promise((resolve, reject) => {
        dirEntry.getFile(path, {}, resolve, reject);
      });
    },

    /**
     * @return {Promise}
     */
    readDir(dirEntry) {
      return new Promise((resolve, reject) => {
        dirEntry.createReader().readEntries(resolve);
      });
    },

    /**
     * @return {Promise}
     */
    createDir(dirEntry, path) {
      return Promise.resolve().then(() => {
        let folders = (Object.prototype.toString.call(path) === "[object Array]") ? path : path.split("/");
        // Throw out './' or '/' and move on to prevent something like '/foo/.//bar'.
        folders = folders.filter(x => x && x !== '.');

        return fileSystemHandler.getDir(folders.join("/")).catch((ex) => {
          const createDirInternal = function (dirEntry, folders) {
            return new Promise((resolve, reject) => {
              dirEntry.getDirectory(folders[0], {create: true}, resolve, reject);
            }).then((dirEntry) => {
              // Recursively add the new subfolder (if we still have another to create).
              if (folders.length) {
                return createDirInternal(dirEntry, folders.slice(1));
              }
              return dirEntry;
            });
          };
          return createDirInternal(dirEntry, folders);
        });
      });
    },

    /**
     * @return {Promise}
     */
    createFile(dirEntry, path, fileBlob) {
      return this.createDir(dirEntry, path.split("/").slice(0, -1)).then(() => {
        return new Promise((resolve, reject) => {
          dirEntry.getFile(path, {create: true}, resolve, reject);
        });
      }).then((fileEntry) => {
        return new Promise((resolve, reject) => {
          fileEntry.createWriter(resolve, reject);
        });
      }).then((fileWriter) => {
        return new Promise((resolve, reject) => {
          fileWriter.onwriteend = resolve;
          fileWriter.onerror = reject;
          fileWriter.write(fileBlob);
        });
      });
    }
  };

  const viewer = {
    mainUrl: new URL(document.URL),
    filesystem: null,
    urlSearch: "",
    urlHash: "",

    warn(msg) {
      console.warn(msg);
      alert(msg);
    },

    openUrl(url, inNewTab = false) {
      if (inNewTab) {
        // In Firefox, a window.open popup is blocked by default, and the 
        // user has to manually add an exception to the popup blocker.
        // However, there's a bug causing notification now shown when
        // a popup is blocked (Bug 1396745).
        //
        // browser.tabs.create fails silently in Firefox private window.
        //
        // browser.tabs is undefined in a Firefox addon page in a frame.
        if (scrapbook.isGecko) {
          return Promise.resolve().then(() => {
            return browser.tabs.getCurrent().then((tab) => {
              if (tab.incognito) { throw new Error('private window'); }
              return browser.tabs.create({url: url, active: false});
            });
          }).catch((ex) => {
            window.open(url);
          });
        }

        window.open(url);
        return;
      }

      if (_isFxBelow56) {
        // In Firefox < 56, the addon page cannot redirect itself to a blob
        // page generated by itself sometimes due to an unclear reason
        // (loading never completes).  Fallback by creating a new tab and
        // removing the old one.
        //
        // browser.tabs.create fails silently in Firefox private window.
        // Fallback with window.open (need a delay or the new tab won't load)
        // (the user has to manually add an exception to the popup blocker).
        //
        // browser.tabs is undefined in a Firefox addon page in a frame, but
        // we don't need to handle the case since Firefox < 56 doesn't view
        // archive in a frame (see viewer/background.js).
        //
        // @FIXME:
        // - History of the original tab is lost.
        // - Tab order is not preserved for private window.
        // - In Firefox 51 (?), exception of popup blocker doesn't work.
        return browser.tabs.getCurrent().then((tab) => {
          return Promise.resolve().then(() => {
            if (tab.incognito) { throw new Error('private window'); }
            return browser.tabs.create({url: url, index: tab.index});
          }).catch((ex) => {
            window.open(url);
            return scrapbook.delay(100);
          }).then(() => {
            return browser.tabs.remove(tab.id);
          });
        });
      }

      window.location.replace(url);
    },

    start() {
      viewer.processUrlParams();
    },

    processUrlParams() {
      let zipSourceUrl = viewer.mainUrl.searchParams.get("src");
      if (!zipSourceUrl) { return; }

      let zipSourceUrlObj = new URL(zipSourceUrl);
      viewer.urlSearch = zipSourceUrlObj.search;
      viewer.urlHash = viewer.mainUrl.hash;
      let filename = scrapbook.urlToFilename(zipSourceUrl);

      scrapbook.xhr({
        url: zipSourceUrl,
        responseType: "blob",
      }).then((xhr) => {
        // if header Content-Disposition is defined, use it
        // local request (status = 0) has no response header
        if (xhr.status !== 0) {
          try {
            let headerContentDisposition = xhr.getResponseHeader("Content-Disposition");
            let contentDisposition = scrapbook.parseHeaderContentDisposition(headerContentDisposition);
            filename = contentDisposition.parameters.filename || filename;
          } catch (ex) {}
        }

        let file = new File([xhr.response], filename, {type: Mime.prototype.lookup(filename)});
        return viewer.processZipFile(file);        
      }, (ex) => {
        alert("Unable to load the specified zip file '" + zipSourceUrl + "'");
      });
    },

    /**
     * @return {Promise}
     */
    processZipFile(zipFile) {
      return Promise.resolve().then(() => {
        if (viewer.filesystem) {
          return viewer.viewZipInFileSystem(zipFile);
        } else {
          return viewer.viewZipInMemory(zipFile);
        }
      }).catch((ex) => {
        console.error(ex);
        alert("Unable to open web page archive: " + ex.message);
      });
    },

    parseRdfDocument(doc) {
      const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
      const MAF = "http://maf.mozdev.org/metadata/rdf#";
      const result = {};

      let elems = doc.getElementsByTagNameNS(MAF, "indexfilename");
      let elem = elems[0];
      if (elem) { result.indexfilename = elem.getAttributeNS(RDF, "resource"); }

      return result;
    },

    /**
     * @return {Promise}
     */
    viewZipInFileSystem(zipFile) {
      return Promise.resolve().then(() => {
        const root = viewer.filesystem.root;
        const ns = scrapbook.getUuid();
        const type = scrapbook.filenameParts(zipFile.name)[1].toLowerCase();

        // @TODO: JSZip.loadAsync cannot load a large zip file
        //     (around 2GB, tested in Chrome)
        return new JSZip().loadAsync(zipFile).then((zip) => {
          return fileSystemHandler.createDir(root, ns).then((dirEntry) => {
            let p = Promise.resolve();
            zip.forEach((inZipPath, zipObj) => {
              if (zipObj.dir) { return; }
              p = p.then(() => {
                // @TODO: reading a large file (about 400~500 MB) once into an
                //     arraybuffer could consume too much memory and cause the
                //     extension to shutdown.  Loading in chunks avoids this but
                //     is very slow and unuseful.  We currently use the faster
                //     method.
                return zipObj.async("arraybuffer");
              }).then((ab) => {
                return fileSystemHandler.createFile(root, ns + "/" + inZipPath, new Blob([ab]));
              });
            });
            return p;
          });
        }).then(() => {
          switch (type) {
            case "maff": {
              return fileSystemHandler.getDir(root, ns).then((dirEntry) => {
                return fileSystemHandler.readDir(dirEntry);
              }).then((entries) => {
                let tasks = entries.filter(e => e.isDirectory).map((entry) => {
                  return fileSystemHandler.getFile(entry, "index.rdf").then((fileEntry) => {
                    return new Promise((resolve, reject) => {
                      fileEntry.file(resolve, reject);
                    }).then((file) => {
                      return scrapbook.readFileAsDocument(file);
                    }).then((doc) => {
                      let meta = viewer.parseRdfDocument(doc);
                      return fileSystemHandler.getFile(entry, meta.indexfilename);
                    });
                  }, (ex) => {
                    return fileSystemHandler.readDir(entry).then((entries) => {
                      for (let i = 0, I = entries.length; i < I; ++i) {
                        let entry = entries[i];
                        if (entry.isFile && entry.name.startsWith("index.")) {
                          return entry;
                        }
                      }
                      throw new Error("no index.* in the directory");
                    });
                  }).catch((ex) => {
                    viewer.warn("Unable to get index file in directory: '" + entry.fullPath + "'");
                  });
                });
                return Promise.all(tasks);
              });
            }
            case "htz":
            default: {
              return fileSystemHandler.getFile(root, ns + "/" + "index.html").then((fileEntry) => {
                return [fileEntry];
              });
            }
          }
        }).then((indexFileEntries) => {
          indexFileEntries = indexFileEntries.filter(x => !!x);
          if (!indexFileEntries.length) {
            return viewer.warn("No available data can be loaded from this archive file.");
          }
          let mainFileEntry = indexFileEntries.shift();
          indexFileEntries.forEach((indexFileEntry) => {
            let url = indexFileEntry.toURL() + viewer.urlSearch + viewer.urlHash;
            viewer.openUrl(url, true);
          });
          let url = mainFileEntry.toURL() + viewer.urlSearch + viewer.urlHash;
          viewer.openUrl(url, false);
        });
      });
    },

    /**
     * @return {Promise}
     */
    viewZipInMemory(zipFile) {
      /**
       * @return {Promise}
       */
      const invokeZipViewer = function (zipFile, indexFile, inNewTab) {
        return Promise.resolve().then(() => {
          const uuid = scrapbook.getUuid();
          const key = {table: "viewerCache", id: uuid};

          return Promise.resolve().then(() => {
            if (_isFxBelow56) {
              return scrapbook.readFileAsText(zipFile, false).then((bytes) => {
                return {
                  name: zipFile.name,
                  type: zipFile.type,
                  value: bytes,
                };
              });
            }

            return zipFile;
          }).then((data) => {
            return scrapbook.setCache(key, data);
          }).then(() => {
            let viewerData = {
              virtualBase: chrome.runtime.getURL("viewer/!/"),
              indexFile: indexFile,
              zipId: uuid,
              isGecko: scrapbook.isGecko,
            };

            let content = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width">
<title>${scrapbook.lang("ViewerTitle")}</title>
<script src="${chrome.runtime.getURL("lib/jszip.js")}"></script>
<script src="${chrome.runtime.getURL("lib/mime.js")}"></script>
<script src="${chrome.runtime.getURL("core/polyfill.js")}"></script>
<script src="${chrome.runtime.getURL("core/common.js")}"></script>
<script src="${chrome.runtime.getURL("viewer/zipviewer.js")}">${JSON.stringify(viewerData)}</script>
<style>
html {
  height: 100%;
}

body {
  margin: 0;
  height: 100%;
}

.full-viewport {
  display: block;
  margin: 0;
  border: 0;
  padding: 0;
  width: 100%;
  height: 100%;
}
</style>
</head>
<body>
<!-- not used: allow-scripts allow-forms allow-top-navigation-by-user-activation -->
<iframe id="viewer" class="full-viewport" sandbox="allow-modals allow-orientation-lock allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-top-navigation"></iframe>
</body>
</html>
`;

            let url = URL.createObjectURL(new Blob([content], {type: "text/html"})) + viewer.urlHash;
            viewer.openUrl(url, inNewTab);
          });
        });
      };

      return Promise.resolve().then(() => {
        const type = scrapbook.filenameParts(zipFile.name)[1].toLowerCase();
        switch (type) {
          case "maff": {
            return new JSZip().loadAsync(zipFile).then((zip) => {
              // get a list of top-folders
              let topdirs = {};
              zip.forEach((subPath, zipObj) => {
                let depth = Array.prototype.filter.call(subPath, x => x == "/").length;
                if (depth == 1) {
                  let dirname = subPath.replace(/\/.*$/, "");
                  if (!topdirs[dirname]) { topdirs[dirname] = zip.folder(dirname); }
                }
              });
              return topdirs;
            }).then((topdirs) => {
              const tasks = [];
              for (let i in topdirs) {
                let dirObj = topdirs[i];
                tasks[tasks.length] = Promise.resolve().then(() => {
                  let rdfFile = dirObj.file("index.rdf");
                  if (!rdfFile) { throw new Error("no index.rdf"); }
                  return rdfFile;
                }).then((rdfFile) => {
                  return rdfFile.async("arraybuffer").then((ab) => {
                    let filename = rdfFile.name.replace(/.*\//, "");
                    let mime = Mime.prototype.lookup(filename);
                    let file = new File([ab], filename, {type: mime});
                    return scrapbook.readFileAsDocument(file);
                  }).then((doc) => {
                    let meta = viewer.parseRdfDocument(doc);
                    if (dirObj.file(meta.indexfilename)) {
                      return meta.indexfilename;
                    }
                  });
                }, (ex) => {
                  let indexFilename;
                  dirObj.forEach((subPath, zipObj) => {
                    if (!zipObj.dir && subPath.indexOf("/") === -1 && subPath.startsWith("index.")) {
                      if (!indexFilename) { indexFilename = subPath; }
                    }
                  });
                  return indexFilename;
                }).then((indexFilename) => {
                  if (!indexFilename) { throw new Error("no available index file"); }
                  return {zip: dirObj, indexFile: indexFilename, inNewTab: true};
                }).catch((ex) => {
                  viewer.warn("Unable to get index file in the directory: '" + dirObj.root + "'");
                });
              }
              return Promise.all(tasks);
            }).then((topdirs) => {
              topdirs = topdirs.filter(x => !!(x && x.indexFile));
              if (!topdirs.length) {
                return viewer.warn("No available data can be loaded from this archive file.");
              }
              let mainDir = topdirs.shift();
              mainDir.inNewTab = false;
              topdirs.push(mainDir);
              let p = Promise.resolve();
              let tasks = topdirs.map((topdir) => {
                return p = p.then(() => {
                  return topdir.zip.generateAsync({type: "blob"});
                }).then((zipBlob) => {
                  let f = new File([zipBlob], zipFile.name, {type: zipBlob.type});
                  return invokeZipViewer(f, topdir.indexFile, topdir.inNewTab);
                });
              });
              return Promise.all(tasks);
            });
          }
          case "htz":
          default: {
            // @FIXME
            // Firefox Android gets an error if we simply pass the zipFile
            // due to unclear reason.  Passing regenerated (which is uncompressed)
            // zip file resolves the issue.
            return new JSZip().loadAsync(zipFile).then((zip) => {
              return zip.generateAsync({type: "blob"});
            }).then((zipBlob) => {
              let f = new File([zipBlob], zipFile.name, {type: zipBlob.type});
              return invokeZipViewer(f, "index.html");
            });
          }
        }
      });
    }
  };

  // init common elements and events
  const fileSelector = document.getElementById('file-selector');
  const fileSelectorInput = document.getElementById('file-selector-input');

  fileSelector.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    e.target.classList.add("dragover");
  }, false);

  fileSelector.addEventListener("drop", (e) => {
    e.preventDefault();
    e.target.classList.remove("dragover");
    Array.prototype.forEach.call(e.dataTransfer.items, (item) => {
      let entry = item.webkitGetAsEntry();
      if (entry.isFile) {
        entry.file((file) => {
          viewer.processZipFile(file);
        });
      }
    });
  }, false);

  fileSelector.addEventListener("dragleave", (e) => {
    e.target.classList.remove("dragover");
  }, false);

  fileSelector.addEventListener("click", (e) => {
    e.preventDefault();
    fileSelectorInput.click();
  }, false);

  fileSelectorInput.addEventListener("change", (e) => {
    e.preventDefault();
    let file = e.target.files[0];
    viewer.processZipFile(file);
  }, false);

  return Promise.resolve().then(() => {
    if (scrapbook.getOption("viewer.useFileSystemApi")) {
      return new Promise((resolve, reject) => {
        window.requestFileSystem = window.requestFileSystem || window.webkitRequestFileSystem;
        // @TODO: Request a 5GB filesystem currently. Do we need larger space or make it configurable?
        window.requestFileSystem(window.TEMPORARY, 5*1024*1024*1024, resolve, reject);
      }).then((fs) => {
        viewer.filesystem = fs;
      });
    }
  }).catch((ex) => {
    // console.error(ex);
  }).then(() => {
    viewer.start();
  });
}

document.addEventListener("DOMContentLoaded", function () {
  scrapbook.loadLanguages(document);
  scrapbook.loadOptions().then(init);
});
