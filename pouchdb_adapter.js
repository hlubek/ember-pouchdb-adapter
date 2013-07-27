(function() {
  var get = Ember.get, set = Ember.set;

  DS.PouchDBSerializer = DS.JSONSerializer.create({
    addBelongsTo: function(hash, record, key, relationship) {
      hash[relationship.key] = get(get(record, key), 'id');
    },

    addHasMany: function(hash, record, key, relationship) {
      var ids = get(record, key).map(function(child) {
        return get(child, 'id');
      });

      var a = [];
      ids.forEach(function(id) {
        a.push(id);
      });
      hash[relationship.key] = a;
    },

    addId: function(hash, type, id) {
      hash._id = type.toString() + '-' + id;
      hash.id = id;
    },

    extractId: function(type, hash) {
      // newly created records should not try to materialize
      if (hash && hash.id) {
        return hash.id;
      }
    },

    toJSON: function(record, options) {
      options = options || {};

      var hash = {}, id;

      if (options.includeId) {
        if (id = get(record, 'id')) {
          this.addId(hash, record.constructor, id);
        }
      }

      this.addAttributes(hash, record);

      this.addRelationships(hash, record);

      return hash;
    }
  });

  /**
   * Based on https://github.com/panayi/ember-data-indexeddb-adapter and https://github.com/wycats/indexeddb-experiment
   *
   */
  DS.PouchDBAdapter = DS.Adapter.extend({
    serializer: DS.PouchDBSerializer,

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
     Takes a (record) or (a modelType and an id)
     and build the serialized id [type, id] to be stored in the db.
     **/
    dbId: function(obj, id) {
      if (obj instanceof DS.Model) {
        return [obj.constructor.toString(), get(obj, 'id')]
      } else {
        return [obj.toString(), id];
      }
    },

    toJSON: function(record, options) {
      return get(this, 'serializer').toJSON(record, options);
    },

    /**
     Main hook for saving a newly created record.

     @param {DS.Store} store
     @param {Class} type
     @param {DS.Model} records
     */
    createRecord: function(store, type, record) {
      var hash = this.toJSON(record, { includeId: true });

      // Store the type in the value so that we can index it on read
      hash.recordType = type.toString();

      this._getDb().put(hash, function(err, response) {
        if (!err) {
          store.didSaveRecord(record);
        } else {
          console.error(err);
        }
      });
    },

    /**
     Main hook for updating an existing record.

     @param {DS.Store} store
     @param {Class} type
     @param {DS.Model} record
     */
    updateRecord: function(store, type, record) {
      var hash = this.toJSON(record, { includeId: true });
      var self = this;

      // Store the type in the value so that we can index it on read
      hash._type = type.toString();

      this.attemptDbTransaction(store, record, function(dbStore) {
        return dbStore.put(hash);
      });
    },

    /**
     Main hook for deleting an existing record. Note that
     deletions can also trigger changes in relationships with
     other records.

     If those records are unloaded, those changes happen
     through the update*Relationship family of methods.

     @param {DS.Store} store
     @param {Class} type
     @param {DS.Model} record
     */
    deleteRecord: function(store, type, record) {
      var self = this;
      this.attemptDbTransaction(store, record, function(dbStore) {
        return dbStore['delete'](self.dbId(record));
      });
    },

    /**
     The main hook for finding a single record. The `findMany`
     hook defaults to delegating to this method.

     Since the IndexedDB database is local, we don't need to
     implement a specific `findMany` method.

     @param {DS.Store} store
     @param {Class} type
     @param {String|Number} id
     */
    find: function(store, type, id) {
      var self = this;
      var db = this._getDb();

      db.query({map: function(doc) {
        if (doc.recordType) {
          emit(doc.recordType, null);
        }
      }}, {reduce: false, key: type.toString(), include_docs: true}, function(err, response) {
        if (err) {
          console.error(err);
        } else {
          if (response.rows && response.rows[0]) {
            self.didFindRecord(store, type, response.rows[0].doc, id);
          }
        }
      });
    },

    didFindRecord: function(store, type, hash, id) {
      if (hash) {
        store.load(type, hash);
      }
    },

    findMany: function(store, type, ids) {
      var self = this;
      var db = this._getDb(),
          records = Ember.A();

      db.allDocs({keys: ids.map(function(id) { return type.toString() + '-' + id; }), include_docs: true}, function(err, response) {
        if (err) {
          console.error(err);
        } else {
          if (response.rows) {
            response.rows.forEach(function(row) {
              records.pushObject(row);
            });
            self.didFindMany(store, type, records);
          }
        }
      });
    },

    didFindMany: function(store, type, records) {
      store.loadMany(type, records);
    },

    findAll: function(store, type) {
      var cursor, records = [], self = this;

      var onSuccess = function(event) {
        if (cursor = event.target.result) {
          records.pushObject(cursor.value);
          cursor.continue();
        } else {
          self.didFindAll(store, type, records);
        }
      };

      this.read(store, type, onSuccess);
    },

    didFindAll: function(store, type, records) {
      store.loadMany(type, records);
    },

    /**
     Using a cursor that loops through *all* results, comparing each one against the query.
     TODO: For performance reasons we should use indexes on query attributes.
     (https://developer.mozilla.org/en-US/docs/IndexedDB/Using_IndexedDB#Using_an_index)

     @param {DS.Store} store
     @param {Class} type
     @param {Object} query
     @param {Array} array
     */
    findQuery: function(store, type, query, array) {
      var match = function(hash, query) {
        result = true;
        for (var key in query) {
          if (query.hasOwnProperty(key)) {
            result = result && (hash[key] === query[key]);
          }
        }
        return result;
      };

      var cursor, records = [], self = this;
      var onSuccess = function(event) {
        if (cursor = event.target.result) {
          if (match(cursor.value, query)) {
            records.pushObject(cursor.value);
          }
          cursor.continue();
        } else {
          self.didFindQuery(store, type, array, records);
        }
      };

      this.read(store, type, onSuccess);
    },

    didFindQuery: function(store, type, array, records) {
      array.load(records);
    },

    /**
     *
     * @param {IDBObjectStore} dbStore
     * @param {string} type
     * @returns {*}
     */
    buildRequest: function(dbStore, type) {
      // Index on modelType for faster querying
      var index = dbStore.index('_type');
      var IDBKeyRange = window.IDBKeyRange || window.webkitIDBKeyRange;
      var onlyOfType = IDBKeyRange.only(type.toString());

      return request = index.openCursor(onlyOfType);
    },

    /**
     @private

     Attempt to commit a change to a single Ember Data
     record in the context of an IndexedDB transaction.
     This method delegates most of its work to
     `withDbTransaction`.

     It registers a `success` callback on the `IDBRequest`
     returned by `withDbTransaction`, which notifies the
     Ember Data store that the record was successfully
     saved.

     @param {DS.Store} store the store to notify that the
     record was successfully saved to IndexedDB.
     @param {DS.Model} record the record to save. This
     parameter is passed through to the store's
     `didSaveRecord` method if the IndexedDB request
     succeeds.
     @param {Function} callback a function that actually
     makes a request to the IndexedDB database. It is
     invoked with an `IDBObjectStore`, and is expected
     to return an `IDBRequest`.
     */
    attemptDbTransaction: function(store, record, callback) {
      var self = this;
      this.getDb(store).then(function(db) {
        var dbName = self._getDatabaseName(),
            dbTransaction = db.transaction([dbName], 'readwrite'),
            dbStore = dbTransaction.objectStore(dbName);

        callback.call(self, dbStore);
          // Use the transaction complete event instead of request success
        dbTransaction.oncomplete = function() {
          store.didSaveRecord(record);
        };
      });
    },

    // private

    _getDatabaseName: function() {
      return this.databaseName || 'ember-application-db';
    },

    _getDb: function() {
      if (!this.db) {
        this.db = new PouchDB(this._getDatabaseName());
      }
      return this.db;
    }

  });
})();
