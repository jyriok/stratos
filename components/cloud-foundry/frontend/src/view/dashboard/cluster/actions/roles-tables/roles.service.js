(function () {
  'use strict';

  angular
    .module('cloud-foundry.view.dashboard.cluster')
    .factory('appClusterRolesService', appClusterRolesService);

  /**
   * @name appClusterRolesService
   * @description Service to handle the data required/created by roles tables. This includes the ability to reach out
   * and update CF roles. Covers functionality used by Assign/Manage/Change users slide outs and Users tables.
   * @constructor
   * @param {object} $log - the angular $log service
   * @param {object} $q - the angular $q service
   * @param {object} $interpolate - the angular $interpolate service
   * @param {object} $translate - the angular $translate service
   * @param {app.model.modelManager} modelManager - the model management service
   * @param {app.utils.appEventService} appEventService - the event bus service
   * @param {app.view.appNotificationsService} appNotificationsService - the toast notification service
   * @param {app.framework.widgets.dialog.frameworkDialogConfirm} frameworkDialogConfirm - the framework confirm dialog service
   * @param {object} cfOrganizationModel - the cfOrganizationModel service
   * @property {boolean} changingRoles - True if roles are currently being changed and cache updated
   * @property {object} organizationRoles - Lists org roles and their translations
   * @property {object} spaceRoles - Lists space roles and their translations
   * @property {function} removeOrgRole - Remove user from a specific organization role
   * @property {function} removeSpaceRole - Remove user from a specific space role
   * @property {function} removeAllRoles - Remove users from all organizations and spaces in a cluster
   * @property {function} removeFromOrganization - Remove users from an organization and it's spaces
   * @property {function} removeFromSpace - Remove users from a space
   * @property {function} assignUsers - Assign organization and space roles for the users supplied. does not cover
   * removing roles.
   * @property {function} updateUsers - Update (assign or remove) organization and space roles for the users supplied
   * @property {function} clearOrg - Clear the organisation + space roles of the organization provided
   * @property {function} clearOrgs - Clear all organisation and their space roles from the selection provided
   * @property {function} orgContainsRoles - Determine if the organisation provided and it's spaces has any roles
   * selected
   */
  function appClusterRolesService($log, $q, $interpolate, $translate, modelManager, appEventService,
    appNotificationsService, frameworkDialogConfirm, cfOrganizationModel) {
    var that = this;

    var spaceModel = modelManager.retrieve('cloud-foundry.model.space');
    var authModel = modelManager.retrieve('cloud-foundry.model.auth');
    var usersModel = modelManager.retrieve('cloud-foundry.model.users');
    var consoleInfo = modelManager.retrieve('app.model.consoleInfo');

    var promiseForUsers;

    this.changingRoles = false;

    // Some helper functions which list all org/space roles and also links them to their labels translations.
    this.organizationRoles = {
      org_manager: 'cf.roles.role-labels.org.short.org_manager',
      org_auditor: 'cf.roles.role-labels.org.short.org_auditor',
      billing_manager: 'cf.roles.role-labels.org.short.billing_manager',
      org_user: 'cf.roles.role-labels.org.short.org_user'
    };
    this.spaceRoles = {
      space_manager: 'cf.roles.role-labels.space.short.space_manager',
      space_auditor: 'cf.roles.role-labels.space.short.space_auditor',
      space_developer: 'cf.roles.role-labels.space.short.space_developer',
      org_user_filler: ''
    };

    // Helper function to link org/space operation to a function
    var rolesToFunctions = {
      org: {
        add: {
          org_manager: _.bind(cfOrganizationModel.associateManagerWithOrganization, cfOrganizationModel),
          org_auditor: _.bind(cfOrganizationModel.associateAuditorWithOrganization, cfOrganizationModel),
          billing_manager: _.bind(cfOrganizationModel.associateBillingManagerWithOrganization, cfOrganizationModel),
          org_user: _.bind(cfOrganizationModel.associateUserWithOrganization, cfOrganizationModel)

        },
        remove: {
          org_manager: _.bind(cfOrganizationModel.removeManagerFromOrganization, cfOrganizationModel),
          org_auditor: _.bind(cfOrganizationModel.removeAuditorFromOrganization, cfOrganizationModel),
          billing_manager: _.bind(cfOrganizationModel.removeBillingManagerFromOrganization, cfOrganizationModel),
          org_user: _.bind(cfOrganizationModel.removeUserFromOrganization, cfOrganizationModel)
        }
      },
      space: {
        add: {
          space_manager: _.bind(spaceModel.associateManagerWithSpace, spaceModel),
          space_auditor: _.bind(spaceModel.associateAuditorWithSpace, spaceModel),
          space_developer: _.bind(spaceModel.associateDeveloperWithSpace, spaceModel)
        },
        remove: {
          space_manager: _.bind(spaceModel.removeManagerFromSpace, spaceModel),
          space_auditor: _.bind(spaceModel.removeAuditorFromSpace, spaceModel),
          space_developer: _.bind(spaceModel.removeDeveloperFromSpace, spaceModel)
        }
      }
    };

    this.canRemoveOrgRole = function (role, clusterGuid, orgGuid, userGuid) {

      var isAllowed = authModel.isAllowed(clusterGuid,
        authModel.resources.organization,
        authModel.actions.update, orgGuid);

      if (!isAllowed) {
        return false;
      }

      if (role !== 'org_user') {
        return true;
      }

      var hasOtherRoles, spaceGuid;

      var org = cfOrganizationModel.organizations[clusterGuid][orgGuid];
      var orgRoles = org.roles[userGuid];
      if (orgRoles && orgRoles.length > 0 && (orgRoles.length > 1 || orgRoles[0] !== 'org_user')) {
        hasOtherRoles = true;
      } else {
        var clusterSpaces = spaceModel.spaces[clusterGuid];
        for (spaceGuid in org.spaces) {
          if (!org.spaces.hasOwnProperty(spaceGuid)) {
            continue;
          }

          var space = clusterSpaces[spaceGuid];
          var spaceRoles = space.roles ? space.roles[userGuid] : null;
          if (spaceRoles && spaceRoles.length) {
            hasOtherRoles = true;
            break;
          }
        }
      }

      return !hasOtherRoles;
    };

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.removeOrgRole
     * @description Remove user from a specific organization role
     * @param {string} clusterGuid - CF service guid
     * @param {string} orgGuid - the organizations guid
     * @param {object} user - CF user object for the user whose role will be removed
     * @param {string} orgRole - the organisation role to be removed from, for example org_manager
     * @returns {promise} Resolved if changes occurred, Rejected if no changes or failure
     */
    this.removeOrgRole = function (clusterGuid, orgGuid, user, orgRole) {
      if (_.indexOf(_.keys(this.organizationRoles), orgRole) < 0) {
        return $q.reject('Cannot remove unknown role: ', orgRole);
      }
      var path = user.metadata.guid + '.' + orgGuid + '.organization.' + orgRole;
      var oldRolesByUser = _.set({}, path, true);
      var newRolesByUser = _.set({}, path, false);

      return updateUsersOrgsAndSpaces(clusterGuid, [user], oldRolesByUser, newRolesByUser);
    };

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.removeSpaceRole
     * @description Remove user from a specific space role
     * @param {string} clusterGuid - CF service guid
     * @param {string} orgGuid - the organizations guid
     * @param {string} spaceGuid - the space guid
     * @param {object} user - CF user object for the user whose role will be removed
     * @param {string} spaceRole - the space role to be removed from, for example space_developer
     * @returns {promise} Resolved if changes occurred, Rejected if no changes or failure
     */
    this.removeSpaceRole = function (clusterGuid, orgGuid, spaceGuid, user, spaceRole) {
      if (!_.indexOf(_.keys(this.spaceRoles), spaceRole) < 0) {
        return $q.reject('Cannot remove unknown role: ', spaceRole);
      }
      var path = user.metadata.guid + '.' + orgGuid + '.spaces.' + spaceGuid + '.' + spaceRole;
      var oldRolesByUser = _.set({}, path, true);
      var newRolesByUser = _.set({}, path, false);

      return updateUsersOrgsAndSpaces(clusterGuid, [user], oldRolesByUser, newRolesByUser);
    };

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.removeAllRoles
     * @description Remove users from all organizations and spaces in a cluster
     * @param {string} clusterGuid - CF service guid
     * @param {Array} users - Array of CF user objects to be removed from the space
     * @returns {promise} Resolved if changes occurred, Rejected if no changes or failure
     */
    this.removeAllRoles = function (clusterGuid, users) {
      var oldRolesByUser = createCurrentRoles(users, clusterGuid);

      // Need to create a 'newRolesByUser' struct just like oldRolesByUser except flips any org/space role 'truthy' to
      // 'falsy'.
      var newRolesByUser = _.cloneDeep(oldRolesByUser);
      _.forEach(newRolesByUser, function (userRoles) {
        that.clearOrgs(userRoles);
      });

      return updateUsersOrgsAndSpaces(clusterGuid, users, oldRolesByUser, newRolesByUser);
    };

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.removeFromOrganization
     * @description Remove users from an organization and it's spaces
     * @param {string} clusterGuid - CF service guid
     * @param {string} orgGuid - the organizations guid
     * @param {Array} users - Array of CF user objects to be removed from the space
     * @returns {promise} Resolved if changes occurred, Rejected if no changes or failure
     */
    this.removeFromOrganization = function (clusterGuid, orgGuid, users) {
      var oldRolesByUser = createCurrentRoles(users, clusterGuid, orgGuid);

      // Need to create a 'newRolesByUser' struct just like oldRolesByUser except flips any org/space role 'truthy' to
      // 'falsy'.
      var newRolesByUser = _.cloneDeep(oldRolesByUser);
      _.forEach(newRolesByUser, function (userRoles) {
        that.clearOrgs(userRoles);
      });

      return updateUsersOrgsAndSpaces(clusterGuid, users, oldRolesByUser, newRolesByUser);
    };

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.removeFromSpace
     * @description Remove users from a space
     * @param {string} clusterGuid - CF service guid
     * @param {string} orgGuid - the organizations guid
     * @param {string} spaceGuid - the space guid
     * @param {Array} users - Array of CF user objects to be removed from the space
     * @returns {promise} Resolved if changes occurred, Rejected if no changes or failure
     */
    this.removeFromSpace = function (clusterGuid, orgGuid, spaceGuid, users) {
      var oldRolesByUser = createCurrentRoles(users, clusterGuid, orgGuid, spaceGuid);

      // Create a new struct that flips any 'truthy' space role to false
      var newRolesByUser = _.cloneDeep(oldRolesByUser);
      _.forEach(newRolesByUser, function (userRoles) {
        _.forEach(userRoles, function (org) {
          _.forEach(org.spaces, function (space) {
            clearRoleArray(space);
          });
        });
      });

      return updateUsersOrgsAndSpaces(clusterGuid, users, oldRolesByUser, newRolesByUser);

    };

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.assignUsers
     * @description Assign organization and space roles for the users supplied. does not cover
     * removing roles. If successful refresh the cache of the affected organizations and spaces
     * @param {string} clusterGuid - CF service guid
     * @param {object} selectedUsers - collection of users to apply roles to
     * @param {object} newRoles - Object containing the new roles to apply. Format is...
     *  Organizations... [orgGuid].organization[roleKey] = truthy
     *  Spaces...        [orgGuid].spaces[spaceGuid][roleKey] = truthy
     * @returns {promise} Resolved if changes occurred, Rejected if no changes or failure
     */
    this.assignUsers = function (clusterGuid, selectedUsers, newRoles) {

      // updateUsersOrgsAndSpaces expects a collection of previously selected roles. The diff of which
      // will be used to determine which assign or remove call to make to CF.
      // For the assign users case we only want to make assign calls. So we need to make an oldRoles which is an
      // identical copy of the newRoles and reverse all 'true' to 'false'
      // Note - This ignores the users currently assigned roles, so there's a chance surplus requests are made

      var oldRoles = angular.fromJson(angular.toJson(newRoles));

      function flopTrueToFalse(obj) {
        _.forEach(obj, function (val, key) {
          if (val === true) {
            obj[key] = false;
          }
        });
      }

      _.forEach(oldRoles, function (oldRole) {
        flopTrueToFalse(oldRole.organization);
        _.forEach(oldRole.spaces, function (space) {
          flopTrueToFalse(space);
        });
      });

      // We require the roles per user, so create the required structs
      var oldRolesByUser = createRolesByUserObj(selectedUsers, oldRoles);
      var newRolesByUser = createRolesByUserObj(selectedUsers, newRoles);

      return updateUsersOrgsAndSpaces(clusterGuid, selectedUsers, oldRolesByUser, newRolesByUser);
    };

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.updateUsers
     * @description Update (assign or remove) organization and space roles for the users supplied
     * @param {string} clusterGuid - CF service guid
     * @param {Array} selectedUsers - collection of users to apply roles to
     * @param {object} newRoles - Object containing the new roles to apply. Format is...
     *  Organizations... [orgGuid].organization[roleKey] = truthy
     *  Spaces...        [orgGuid].spaces[spaceGuid][roleKey] = truthy
     * @returns {promise} Resolved if changes occurred, Rejected if no changes or failure
     */
    this.updateUsers = function (clusterGuid, selectedUsers, newRoles) {
      var oldRolesByUser = createCurrentRoles(selectedUsers, clusterGuid);
      var newRolesByUser = createRolesByUserObj(selectedUsers, newRoles);

      return updateUsersOrgsAndSpaces(clusterGuid, selectedUsers, oldRolesByUser, newRolesByUser);
    };

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.clearOrg
     * @description Clear the organisation + space roles of the organization provided
     * @param {object} org - organization to clear. Format as below.
     *  organization[roleKey] = truthy
     *  spaces[spaceGuid][roleKey] = truthy
     */
    this.clearOrg = function (org) {
      clearRoleArray(org.organization);
      _.forEach(org.spaces, function (space) {
        clearRoleArray(space);
      });
    };

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.clearOrgs
     * @description clearOrgs Clear all organisation and their space roles from the selection provided
     * @param {object} orgs - object organization to clear. Format as below.
     *  [orgGuid]organization[roleKey] = truthy
     *  [orgGuid]spaces[spaceGuid][roleKey] = truthy
     */
    this.clearOrgs = function (orgs) {
      var that = this;
      _.forEach(orgs, function (org) {
        that.clearOrg(org);
      });
    };

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.orgContainsRoles
     * @description Determine if the organisation provided and it's spaces has any roles selected
     * @param {object} org - organization to test. Format as below.
     *  organization[roleKey] = truthy
     *  spaces[spaceGuid][roleKey] = truthy
     * @returns {boolean}
     */
    this.orgContainsRoles = function (org) {
      if (!org) {
        return false;
      }

      if (org.organization) {
        var orgContainsRoles = _.find(org.organization, function (role) {
          return role;
        });
        if (orgContainsRoles) {
          return true;
        }
      }

      var spaces = org.spaces;
      if (!spaces) {
        return false;
      }
      for (var spaceGuid in spaces) {
        if (!spaces.hasOwnProperty(spaceGuid)) {
          continue;
        }
        if (_.find(spaces[spaceGuid])) {
          return true;
        }
      }
      return false;
    };

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.updateRoles
     * @description Ensure that the provided roles pass org_user rules. Specifically user must be org_user if any other
     * role is assigned
     * @param {object} roles - roles to check. Format as below.
     *  organization[roleKey] = truthy
     *  spaces[spaceGuid][roleKey] = truthy
     */
    this.updateRoles = function (roles) {
      if (!that.orgContainsRoles(roles)) {
        return;
      }
      if (!roles.organization) {
        roles.organization = {};
      }
      roles.organization.org_user = true;
    };

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.listUsers
     * @description Fetch a list of users in all organizations the connected user can see. For a cluster admin this is
     * done in a single call to listAllUsers, for non-cluster admin this is done via a call to each organization they
     * can see
     * @param {string} clusterGuid - CF service guid
     * @param {boolean} forceRefresh - set to true to always reach out to CF instead of using cached version
     * @returns {promise} Promise containing Array of users.
     */
    this.listUsers = function (clusterGuid, forceRefresh) {
      var isAdmin = consoleInfo.info.endpoints.cf[clusterGuid].user.admin;
      if (!forceRefresh && angular.isDefined(promiseForUsers)) {
        return promiseForUsers;
      }
      if (isAdmin) {
        promiseForUsers = usersModel.listAllUsers(clusterGuid);
      } else {
        var allUsersP = [];
        _.forEach(cfOrganizationModel.organizations[clusterGuid], function (org) {
          allUsersP.push(cfOrganizationModel.retrievingRolesOfAllUsersInOrganization(clusterGuid, org.details.guid));
        });
        promiseForUsers = $q.all(allUsersP).then(function (results) {
          var allUsers = {};
          _.forEach(results, function (usersArray) {
            _.forEach(usersArray, function (aUser) {
              allUsers[aUser.metadata.guid] = aUser;
            });
          });
          // Pre-sort users to avoid smart-table flicker in the endpoints dashboard
          return _.sortBy(_.values(allUsers), function (u) {
            if (u.entity.username) {
              return u.entity.username.toLowerCase();
            }
            return u.entity.username;
          });
        });
      }
      return promiseForUsers;
    };

    function clearRoleArray(roleObject) {
      // Ensure that we flip any selected role. Do this instead of null/undefined/delete to ensure that the diff
      // between previous and current roles acts correctly (removed val from roles object would just be ignored and thus
      // not removed)
      _.forEach(roleObject, function (selected, roleKey) {
        if (selected) {
          roleObject[roleKey] = false;
        }
      });
    }

    /**
     * @name createCurrentRoles
     * @description Determines the org and space roles for the users provided
     * @param {Array} users - array of CF user objects
     * @param {string} clusterGuid - console service guid for cluster
     * @param {string=} singleOrgGuid - restrict result to a single org
     * @param {string=} singleSpaceGuid - restrict result to a single space
     * @returns {object} Structure is...
     * [userGuid][orgGuid].organization[roleKey] = truthy
     * [userGuid][orgGuid].spaces[spaceGuid][roleKey] = truthy
     */
    function createCurrentRoles(users, clusterGuid, singleOrgGuid, singleSpaceGuid) {
      var rolesByUser = {};
      _.forEach(cfOrganizationModel.organizations[clusterGuid], function (org, orgGuid) {
        if (!singleOrgGuid || singleOrgGuid === orgGuid) {
          _.forEach(org.roles, function (roles, userGuid) {
            if (_.find(users, {metadata: {guid: userGuid}})) {
              _.set(rolesByUser, userGuid + '.' + orgGuid + '.organization', _.keyBy(roles));
            }
          });

          _.forEach(org.spaces, function (space) {
            var spaceGuid = space.metadata.guid;
            space = _.get(spaceModel, 'spaces.' + clusterGuid + '.' + spaceGuid, {});
            _.forEach(space.roles, function (roles, userGuid) {
              if (!singleSpaceGuid || singleSpaceGuid === spaceGuid) {

                if (_.find(users, {metadata: {guid: userGuid}})) {
                  _.set(rolesByUser, userGuid + '.' + orgGuid + '.spaces.' + spaceGuid, _.keyBy(roles));
                }
              }
            });
          });
        }
      });
      return rolesByUser;
    }

    function createRolesByUserObj(users, roles) {
      var newRolesByUser = {};
      _.forEach(users, function (user) {
        newRolesByUser[user.metadata.guid] = roles;
      });
      return newRolesByUser;
    }

    /* eslint-disable complexity */
    // NOTE - Complexity of 13, left in to improve readability.
    /**
     * @name createConfirmationConfig
     * @description Create a standard confirmation dialog configuration containing call specific text (sensitive to
     * user/s, role/s, assign, remove, etc)
     * @param {Array} users - array of CF user objects
     * @param {object} delta - actual set of roles to assign or unassign
     * @returns {object} confirmation dialog configuration
     */
    function createConfirmationConfig(users, delta) {
      var usernames = _.map(users, 'entity.username');
      var assigns = [];
      var removes = [];

      // Discover the number of assignments and removes, including their human readable string
      // (the lookup for these could be factored out to the end for speed, but for code clarrity doing them inline)
      _.forEach(delta, function (orgsRolesPerUser) {
        _.forEach(orgsRolesPerUser, function (orgRolesPerUser) {

          // Determine organization roles delta
          _.forEach(orgRolesPerUser.organization, function (selected, roleKey) {
            if (selected) {
              assigns.push(that.organizationRoles[roleKey]);
            } else {
              removes.push(that.organizationRoles[roleKey]);
            }
          });

          // Determine spaces roles delta
          _.forEach(orgRolesPerUser.spaces, function (spaceRoles) {
            _.forEach(spaceRoles, function (selected, roleKey) {
              if (selected) {
                assigns.push(that.spaceRoles[roleKey]);
              } else {
                removes.push(that.spaceRoles[roleKey]);
              }
            });
          });
        });
      });

      // Determine the title, description, success message and error message of the confirmation model.
      // These are verbose to allow better localization

      var multipleRoles = assigns.length + removes.length > 1;

      // Determine the title
      var title = multipleRoles ? 'cf.roles.change-roles-confirmation.title.update-plural'
        : 'cf.roles.change-roles-confirmation.title.update-singular';
      if (assigns.length === 0) {
        title = multipleRoles ? 'cf.roles.change-roles-confirmation.title.remove-plural'
          : 'cf.roles.change-roles-confirmation.title.remove-singular';
      } else if (removes.length === 0) {
        title = multipleRoles ? 'cf.roles.change-roles-confirmation.title.assign-plural'
          : 'cf.roles.change-roles-confirmation.title.assign-singular';
      }

      // Determine the description
      var line1 = usernames.length > 1
        ? 'cf.roles.change-roles-confirmation.line-one-plural'
        : 'cf.roles.change-roles-confirmation.line-one-singular';
      var line2 = assigns.length > 1 ? 'cf.roles.change-roles-confirmation.line-assign-plural' : 'cf.roles.change-roles-confirmation.line-assign-singular';
      var line3 = removes.length > 1 ? 'cf.roles.change-roles-confirmation.line-remove-plural' : 'cf.roles.change-roles-confirmation.line-remove-singular';
      var line4 = $translate.instant('cf.roles.change-roles-confirmation.line-four');

      line1 = $translate.instant(line1, {user: usernames[0], users: usernames.join(', ')});
      line2 = $translate.instant(line2, {count: assigns.length, role: $translate.instant(assigns[0])});
      line3 = $translate.instant(line3, {count: removes.length, role: $translate.instant(removes[0])});

      var description =
        line1 + '<br><br>' +
        (assigns.length > 0 ? line2 + '<br>' : '') +
        (removes.length > 0 ? line3 + '<br>' : '') +
        '<br>' + line4;

      // Success and error messages
      var successMessage = multipleRoles ? 'cf.roles.change-roles-confirmation.success-one'
        : 'cf.roles.change-roles-confirmation.success-two';
      if (usernames.length > 1) {
        successMessage = multipleRoles ? 'cf.roles.change-roles-confirmation.success-three'
          : 'cf.roles.change-roles-confirmation.success-four';
      }

      return {
        title: title,
        description: description,
        successMessage: successMessage,
        buttonText: {
          yes: 'buttons.yes',
          no: 'buttons.no'
        },
        windowClass: 'roles-conf-dialog',
        noHtmlEscape: true
      };
    }

    /* eslint-enable complexity */

    /**
     * @name rolesDelta
     * @description Determine the difference between the old/current roles and the new roles to be applied
     * @param {object} oldRoles - Object containing the previously selected roles, or the initial state. Format matches
     * newRoles.
     *  Organizations... [userGuid][orgGuid].organization[roleKey] = truthy
     *  Spaces...        [userGuid][orgGuid].spaces[spaceGuid][roleKey] = truthy
     * @param {object} newRoles - Object containing the new roles to apply. Format matches oldRoles.
     *  Organizations... [userGuid][orgGuid].organization[roleKey] = truthy
     *  Spaces...        [userGuid][orgGuid].spaces[spaceGuid][roleKey] = truthy
     * @param {string} clusterGuid - CNSI Guid
     * @returns {object} confirmation dialog configuration
     */
    function rolesDelta(oldRoles, newRoles, clusterGuid) {
      var delta = angular.fromJson(angular.toJson(newRoles));
      var changes = false;

      // For each user
      _.forEach(delta, function (orgsRolesPerUser, userGuid) {
        // For each org
        _.forEach(orgsRolesPerUser, function (orgRolesPerUser, orgGuid) {

          var oldOrgRolesPerUser = _.get(oldRoles, userGuid + '.' + orgGuid);

          // Calculate org role delta only for organizations for which user is allowed to
          var isUserAllowed = authModel.isAllowed(clusterGuid,
            authModel.resources.organization,
            authModel.actions.update, orgGuid);

          // For each organization role
          _.forEach(orgRolesPerUser.organization, function (selected, roleKey) {
            // Has there been a change in the org role?
            var oldRoleSelected = _.get(oldOrgRolesPerUser, 'organization.' + roleKey) || false;
            if (!isUserAllowed || !!oldRoleSelected === !!selected) {
              delete orgRolesPerUser.organization[roleKey];
            } else {
              changes = true;
            }
          });

          // For each space
          _.forEach(orgRolesPerUser.spaces, function (spaceRoles, spaceGuid) {

            // calculate space role delta only for spaces for which user is allowed
            var isAllowed = authModel.isAllowed(clusterGuid, authModel.resources.space,
              authModel.actions.update, spaceGuid, orgGuid);

            // For each space role
            _.forEach(spaceRoles, function (selected, roleKey) {
              // Has there been a change in the space role?
              var oldRoleSelected = _.get(oldOrgRolesPerUser, 'spaces.' + spaceGuid + '.' + roleKey) || false;
              if (!isAllowed || !!oldRoleSelected === !!selected) {
                delete orgRolesPerUser.spaces[spaceGuid][roleKey];
              } else {
                changes = true;
              }
            });
          });
        });
      });

      return changes ? delta : null;
    }

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.updateUsersOrgsAndSpaces
     * @description Assign the controllers selected users with the selected roles. If successful refresh the cache of
     * the affected organizations and spaces.
     * IMPORTANT!!!!!! This is the conduit for changes that all external calls should flow through. It gates the process
     * on a confirmation model and also handles the global 'changingRoles' flag.
     * @param {string} clusterGuid - CF service guid
     * @param {object} selectedUsers - collection of users to apply roles to
     * @param {object} oldRolesByUser - Object containing the previously selected roles, or the initial state. The diff
     * between this and newRoles will be applied (assign/remove). Format matches newRoles.
     *  Organizations... [userGuid][orgGuid].organization[roleKey] = truthy
     *  Spaces...        [userGuid][orgGuid].spaces[spaceGuid][roleKey] = truthy
     * @param {object} newRolesByUser - Object containing the new roles to apply. The delta of this and oldRoles will be
     * applied (assign/remove). Format matches oldRoles
     * @returns {promise}
     */
    function updateUsersOrgsAndSpaces(clusterGuid, selectedUsers, oldRolesByUser, newRolesByUser) {
      that.changingRoles = true;

      var delta = rolesDelta(oldRolesByUser, newRolesByUser, clusterGuid);

      if (!delta) {
        appNotificationsService.notify('warning', $translate.instant('cf.roles.change-roles-confirmation.notifications.no-changes'));
        that.changingRoles = false;
        return $q.reject();
      }

      var confirmationConfig = createConfirmationConfig(selectedUsers, delta);
      confirmationConfig.callback = function () {
        var failures = [];

        // For each user assign their new roles. Do this asynchronously
        var promises = [];
        _.forEach(selectedUsers, function (user) {
          var promise = updateUserOrgsAndSpaces(clusterGuid, user, delta[user.metadata.guid])
            .catch(function (error) {
              // Swallow promise chain error and track errors separately
              failures.push({user: user.entity.username, error: error});
              $log.error('Failed to update user ' + user.entity.username, error);
            });
          promises.push(promise);
        });

        return $q.all(promises)
          .then(function () {
            // If all async requests have finished invalidate any cache associated with roles
            appEventService.$emit(appEventService.events.ROLES_UPDATED);

            // If something has failed return a failed promise
            if (failures.length > 0) {

              var errorMessage, reason;
              if (failures.length > 1) {
                errorMessage = $translate.instant('cf.roles.change-roles-confirmation.notifications.failure-plural', {
                  failedUsers: _.map(failures, 'user').join(', ')
                });
              } else {
                errorMessage = $translate.instant('cf.roles.change-roles-confirmation.notifications.failure-singular', {
                  failedUsers: _.map(failures, 'user').join(', ')
                });
                reason = _.get(failures[0], 'error.data.description', '');
                errorMessage += reason.length > 0 ? $translate.instant('cf.roles.change-roles-confirmation.notifications.failure-reason', {
                  reason: reason
                }) : '';
              }

              return $q.reject(errorMessage);
            } else {
              // Otherwise notify success, hurrah
              appNotificationsService.notify('success', $translate.instant(confirmationConfig.successMessage));
            }
          });
      };

      return frameworkDialogConfirm(confirmationConfig).result.finally(function () {
        that.changingRoles = false;
      });
    }

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.updateUserOrgsAndSpaces
     * @description As per updateUsersOrgsAndSpaces, except for a single user. This should not be called separately only
     * via updateUsersOrgsAndSpaces.
     * @param {string} clusterGuid - CF service guid
     * @param {object} user - user to apply roles to
     * @param {object} newRolesPerOrg - Object containing the new roles to apply. Format is...
     *  Organizations... [orgGuid].organization[roleKey] = truthy
     *  Spaces...        [orgGuid].spaces[spaceGuid][roleKey] = truthy
     * @returns {promise}
     */
    function updateUserOrgsAndSpaces(clusterGuid, user, newRolesPerOrg) {
      var promises = [];

      _.forEach(newRolesPerOrg, function (newOrgRoles, orgGuid) {
        promises.push(updateUserOrgAndSpaces(clusterGuid, user, orgGuid, newOrgRoles));
      });

      return $q.all(promises);
    }

    /**
     * @name cloud-foundry.view.dashboard.cluster.appClusterRolesService.updateUserOrgAndSpaces
     * @description As per updateUserOrgsAndSpaces, except for a single org. This should not be called separately only
     * via updateUsersOrgsAndSpaces.
     * @param {string} clusterGuid - CF service guid
     * @param {object} user - user to apply roles to
     * @param {object} orgGuid - guid of organization
     * @param {object} newOrgRoles - Object containing the new roles to apply. Format is...
     *  Organizations... organization[roleKey] = truthy
     *  Spaces...        spaces[spaceGuid][roleKey] = truthy
     * @returns {promise}
     */
    function updateUserOrgAndSpaces(clusterGuid, user, orgGuid, newOrgRoles) {

      var userGuid = user.metadata.guid;

      // Need to ensure that we execute organization role changes in a specific order
      // If we're ADDING non-org_user roles we need to first ensure that we complete the add for org_user
      // If we're REMOVING org_user we need to first ensure that we complete the remove of non-org_user roles

      function createOrgRoleRequests(roles) {
        var orgPromises = [];
        // Assign/Remove Organization Roles
        _.forEach(roles, function (selected, roleKey) {
          // We're either assigning a new role or removing an old role....
          if (selected) {
            // ... Assign role.
            orgPromises.push(rolesToFunctions.org.add[roleKey](clusterGuid, orgGuid, userGuid));
          } else {
            // ... Remove role.
            orgPromises.push(rolesToFunctions.org.remove[roleKey](clusterGuid, orgGuid, userGuid));
          }
        });
        return $q.all(orgPromises);
      }

      // preReqPromise will either be a promise that's resolved once the org_user has updated or all non-org_user rolls
      // have changed.
      var preReqPromise = $q.when();
      // Clone the new org roles. This will be the 'to do' list of changes that are executed after preReqPromise.
      var orgRoles = _.clone(newOrgRoles.organization);
      // What are we attempting to set for the org user role?
      var newOrgUser = _.get(orgRoles, 'org_user');

      // Has it changed? Undefined means no change
      if (angular.isDefined(newOrgUser)) {
        delete orgRoles.org_user;

        if (newOrgUser) {
          // We're ADDING the org_user, ensure this occurs BEFORE any other change/s
          preReqPromise = rolesToFunctions.org.add.org_user(clusterGuid, orgGuid, userGuid);
        } else {
          // We're REMOVING the org_user, ensure this occurs AFTER any other change/s
          preReqPromise = createOrgRoleRequests(orgRoles);
          orgRoles = {
            org_user: false
          };
        }
        // By this stage the orgRoles object should contain a set of changes to make after the initial promise is
        // resolved.
      }

      return preReqPromise
        .then(function () {
          return createOrgRoleRequests(orgRoles);
        })
        .then(function () {
          // All organization changes have been made. Continue to space changes
          var updatePromises = [];

          // Assign/Remove Spaces Roles
          _.forEach(newOrgRoles.spaces, function (spaceRoles, spaceGuid) {

            _.forEach(spaceRoles, function (selected, roleKey) {

              if (selected) {
                // Assign role
                updatePromises.push(rolesToFunctions.space.add[roleKey](clusterGuid, spaceGuid, userGuid));
              } else {
                // Remove role
                updatePromises.push(rolesToFunctions.space.remove[roleKey](clusterGuid, spaceGuid, userGuid));
              }

            });
          });
          return $q.all(updatePromises);
        })
        .then(function () {
          // All changes have been made, refresh the local cache of all affected orgs/spaces
          var cachePromises = [];
          // Refresh org cache
          if (_.keys(newOrgRoles.organization).length > 0) {
            cachePromises.push(cfOrganizationModel.refreshOrganizationUserRoles(clusterGuid, orgGuid));
          }

          // Refresh space caches
          _.forEach(newOrgRoles.spaces, function (spaceRoles, spaceGuid) {
            if (_.keys(spaceRoles).length > 0) {
              cachePromises.push(spaceModel.listRolesOfAllUsersInSpace(clusterGuid, spaceGuid));
            }
          });

          return $q.all(cachePromises);
        });

    }

    return this;
  }

})();
