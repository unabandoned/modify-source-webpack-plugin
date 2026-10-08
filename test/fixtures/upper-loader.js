'use strict';

// A stand-in for any loader a project already applies to the module.
module.exports = function upperLoader(source) {
  return source.replace('two-module', 'TWO-MODULE');
};
