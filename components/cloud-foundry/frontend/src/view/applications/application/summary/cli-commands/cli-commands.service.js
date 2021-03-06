(function () {
  'use strict';

  angular
    .module('cloud-foundry.view.applications.application.summary')
    .factory('cfAppCliCommands', CliCommandsFactory);

  /**
   * @memberof cloud-foundry.view.applications.application.summary
   * @name CliCommandsFactory
   * @description Factory to provide a way to show the cli commands for App Summary
   * @constructor
   * @param {app.framework.widgets.frameworkDetailView} frameworkDetailView - The console's frameworkDetailView service
   * @param {object} appUtilsService - appUtilsService service
   */
  function CliCommandsFactory(frameworkDetailView, appUtilsService) {

    return {
      /**
       * @function show
       * @memberof cloud-foundry.view.applications.application.summary
       * @description Show a detail view containing basic cli instructions
       * @param {object} appModel - Application model
       * @param {string} username - Username used to connect to CF
       * @returns {promise} A detail view promise
       * @public
       */
      show: function (appModel, username) {
        var incomplete = appModel.state && appModel.state.label === 'app.state.incomplete';
        var templateName = incomplete ? 'cli-commands-deploy.html' : 'cli-commands.html';
        return frameworkDetailView(
          {
            templateUrl: 'plugins/cloud-foundry/view/applications/application/summary/cli-commands/' + templateName,
            title: incomplete ? 'app.app-info.cli-dialog-deploy.title' : 'app.app-info.cli-dialog-app.title',
            dialog: true,
            class: 'app-cli-commands dialog-form-larger'
          },
          {
            apiEndpoint: appUtilsService.getClusterEndpoint(appModel.cluster),
            orgName: appModel.organization.entity.name,
            spaceName: appModel.space.entity.name,
            appName: appModel.summary.name,
            username: username,
            routes: appModel.summary.routes || [],
            services: appModel.summary.services || []
          }
        );
      }
    };
  }

})();
