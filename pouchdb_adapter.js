(function() {
  var get = Ember.get, set = Ember.set;

  DS.PouchDBSerializer = DS.JSONSerializer.extend({
    primaryKey: '_id',
    normalize: function(type, hash) {
      this._super.apply(this, arguments);
      if (hash._id) {
        hash.id = hash._id;
      }
      return hash;
    },
    serialize: function(record, options) {
      return this._super.apply(this, arguments);
    }
  });

  /**
   * Based on https://github.com/panayi/ember-data-indexeddb-adapter and https://github.com/wycats/indexeddb-experiment
   *
   */
  DS.PouchDBAdapter = DS.Adapter.extend({
    defaultSerializer: 'pouchdb',

    /**
     Hook used by the store to generate client-side IDs. This simplifies
     the timing of committed related records, so it's preferable.

     For this adapter, we use uuid.js by Rober Kieffer, which generates
     UUIDs using the best-available random number generator.

     @returns {String} a UUID
     */
    generateIdForRecord: function() {
      return uuid();
    },

    /**
     Main hook for saving a newly created record.

     @param {DS.Store} store
     @param {Class} type
     @param {DS.Model} records
     */
    createRecord: function(store, type, record) {
      var self = this,
          hash = this.serialize(record, { includeId: true, includeType: true }),
          deferred = Ember.RSVP.defer();

      this._getDb().put(hash, function(err, response) {
        if (!err) {
          set(record, 'data._rev', response.rev);
          deferred.resolve(record);
        } else {
          deferred.reject(err);
        }
      });

      return deferred.promise;
    },

    /**
     Main hook for updating an existing record.

     @param {DS.Store} store
     @param {Class} type
     @param {DS.Model} record
     */
    updateRecord: function(store, type, record) {
      var self = this,
          hash = this.serialize(record, { includeId: true, includeType: true }),
          deferred = Ember.RSVP.defer();

      // Store the type in the value so that we can index it on read
      hash['emberDataType'] = type.toString();

      this._getDb().put(hash, function(err, response) {
        if (err) {
          deferred.reject(err);
        } else {
          deferred.resolve({id: response.id, _rev: response.rev});
        }
      });

      return deferred.promise;
    },

    deleteRecord: function(store, type, record) {
      var self = this,
          deferred = Ember.RSVP.defer();

      this._getDb().remove({
        _id: get(record, 'id'),
        _rev: get(record, 'data._rev')
      }, function(err, response) {
        if (err) {
          deferred.reject(err);
        } else {
          deferred.resolve({id: response.id, _rev: response.rev});
        }
      });

      return deferred.promise;
    },

    find: function(store, type, id) {
      var self = this,
          db = this._getDb(),
          data = [],
          deferred = Ember.RSVP.defer();

      db.get(id, function(err, doc) {
        if (err) {
          deferred.reject(err);
        } else {
          deferred.resolve(doc);
        }
      });

      return deferred.promise;
    },

    findMany: function(store, type, ids) {
      var self = this,
          db = this._getDb(),
          data = [],
          deferred = Ember.RSVP.defer();

      db.allDocs({keys: ids, include_docs: true}, function(err, response) {
        if (err) {
          deferred.reject(err);
        } else {
          if (response.rows) {
            response.rows.forEach(function(row) {
              if (!row.error) {
                data.push(row.doc);
              }
            });
            deferred.resolve(data);
          }
        }
      });

      return deferred.promise;
    },

    findAll: function(store, type, sinceToken) {
      var self = this,
          db = this._getDb(),
          data = [],
          deferred = Ember.RSVP.defer();

      db.query({map: function(doc) {
        if (doc['emberDataType']) {
          emit(doc['emberDataType'], null);
        }
      }}, {reduce: false, key: type.toString(), include_docs: true}, function(err, response) {
        if (err) {
          console.error(err);
        } else {
          if (response.rows) {
            response.rows.forEach(function(row) {
              data.push(row.doc);
            });
            self.didFindAll(store, type, data);
          }
        }
      });

      return deferred.promise;
    },

    findQuery: function(store, type, query, array) {
      var self = this,
          db = this._getDb(),
          deferred = Ember.RSVP.defer();

      var keys = [];
      for (key in query) {
        if (query.hasOwnProperty(key)) {
          keys.push(key);
        }
      }

      var emitKeys = keys.map(function(key) {
        return 'doc.' + key;
      });
      var queryKeys = keys.map(function(key) {
        return query[key];
      });

      // Very simple map function for a conjunction (AND) of all keys in the query
      var mapFn = 'function(doc) {' +
            'if (doc["emberDataType"]) {' +
              'emit([doc["emberDataType"]' + (emitKeys.length > 0 ? ',' : '') + emitKeys.join(',') + '], null);' +
            '}' +
          '}';

      db.query({map: mapFn}, {reduce: false, key: [].concat(type.toString(), queryKeys), include_docs: true}, function(err, response) {
        if (err) {
          deferred.reject(err);
        } else {
          if (response.rows) {
            var data = response.rows.map(function(row) { return row.doc; });
            deferred.resolve(data);
          }
        }
      });

      return deferred.promise;
    },

    // private

    /**
     * Lazily create a PouchDB instance
     *
     * @returns {PouchDB}
     * @private
     */
    _getDb: function() {
      if (!this.db) {
        this.db = new PouchDB(this.databaseName || 'ember-application-db');
      }
      return this.db;
    }

  });

  Ember.onLoad('Ember.Application', function(Application) {
    Application.initializer({
      name: 'pouchdb',
      initialize: function(container, application) {
        application.register('serializer:pouchdb', DS.PouchDBSerializer);
        application.register('adapter:pouchdb', DS.PouchDBAdapter);
      }
    });
  });

})();
