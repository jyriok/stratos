package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/ioutil"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"code.cloudfoundry.org/cli/cf/actors"
	"code.cloudfoundry.org/cli/cf/actors/brokerbuilder"
	"code.cloudfoundry.org/cli/cf/actors/planbuilder"
	"code.cloudfoundry.org/cli/cf/actors/pluginrepo"
	"code.cloudfoundry.org/cli/cf/actors/servicebuilder"
	"code.cloudfoundry.org/cli/cf/api"
	"code.cloudfoundry.org/cli/cf/appfiles"
	"code.cloudfoundry.org/cli/cf/commandregistry"
	"code.cloudfoundry.org/cli/cf/commandsloader"
	"code.cloudfoundry.org/cli/cf/configuration"
	"code.cloudfoundry.org/cli/cf/configuration/confighelpers"
	"code.cloudfoundry.org/cli/cf/configuration/coreconfig"
	"code.cloudfoundry.org/cli/cf/configuration/pluginconfig"
	"code.cloudfoundry.org/cli/cf/manifest"
	"code.cloudfoundry.org/cli/cf/models"
	"code.cloudfoundry.org/cli/cf/net"
	"code.cloudfoundry.org/cli/cf/terminal"
	"code.cloudfoundry.org/cli/cf/trace"
	"code.cloudfoundry.org/cli/util"
	"code.cloudfoundry.org/cli/util/words/generator"
	log "github.com/Sirupsen/logrus"
	"github.com/gorilla/websocket"
	"github.com/labstack/echo"
	uuid "github.com/satori/go.uuid"
	"gopkg.in/src-d/go-git.v4"
	"gopkg.in/src-d/go-git.v4/plumbing"
	"gopkg.in/yaml.v2"
)

type MessageType int

const (

	DATA MessageType = iota + 20000
	MANIFEST
	CLOSE_SUCCESS
	CLOSE_PUSH_ERROR = iota + 40000
	CLOSE_NO_MANIFEST
	CLOSE_INVALID_MANIFEST
	CLOSE_FAILED_CLONE
	CLOSE_FAILURE

	// Time allowed to read the next pong message from the peer
	pongWait = 30 * time.Second

	// Send ping messages to peer with this period (must be less than pongWait)
	pingPeriod = (pongWait * 9) / 10

	// Time allowed to write a ping message
	pingWriteTimeout = 10 * time.Second

	stratosProjectKey = "STRATOS_PROJECT"

)

type ManifestResponse struct {
	Manifest string
}

type SocketWriter struct {
	clientWebSocket *websocket.Conn
}

// Allow connections from any Origin
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type StratosProject struct {
	Url        string      `json:"url"`
	CommitHash string      `json:"commit"`
	Branch     string      `json:"branch"`
	Timestamp  int64      `json:"timestamp"`
}

func (cfAppPush *CFAppPush) deploy(echoContext echo.Context) error {
	log.Info("Deploying app")

	cnsiGUID := echoContext.Param("cnsiGuid")
	orgGuid := echoContext.Param("orgGuid")
	spaceGuid := echoContext.Param("spaceGuid")
	project := echoContext.QueryParam("project")
	branch := echoContext.QueryParam("branch")
	spaceName := echoContext.QueryParam("space")
	orgName := echoContext.QueryParam("org")

	clientWebSocket, pingTicker, err := upgradeToWebSocket(echoContext)
	if err != nil {
		log.Errorf("Upgrade to websocket failed due to: %+v", err)
		return err
	}
	defer clientWebSocket.Close()
	defer pingTicker.Stop()


	log.Infof("Received URL: %s for cnsiGuid", project, cnsiGUID)

	projectUrl := fmt.Sprintf("https://github.com/%s", project)
	clonePath, commitHash, err := cloneRepository(projectUrl, branch)
	if err != nil {
		sendErrorMessage(clientWebSocket, err, CLOSE_FAILED_CLONE)
		return err
	}

	log.Infof("Cloned repository")
	manifest, err := fetchManifest(clonePath, projectUrl, commitHash, branch)
	if err != nil {
		sendErrorMessage(clientWebSocket, err, CLOSE_NO_MANIFEST)
		return err
	}

	log.Infof("WebSocket upgraded!")

	err = sendManifest(manifest, clientWebSocket)
	if err != nil {
		log.Warnf("Failed to read or send manifest due to %s", err)
		sendErrorMessage(clientWebSocket, err, CLOSE_INVALID_MANIFEST)
		return err
	}

	// Initialise push command
	commandsloader.Load()

	socketWriter := &SocketWriter{
		clientWebSocket: clientWebSocket,
	}

	configRepo, err := cfAppPush.getConfigData(echoContext, cnsiGUID, orgGuid, spaceGuid, spaceName, orgName)
	log.Warnf("Error %+v", err)
	if err != nil {
		log.Warnf("Failed to initialise config repo due to error %+v", err)
		sendErrorMessage(clientWebSocket, err, CLOSE_FAILURE)
		return err
	}

	traceLogger := trace.NewLogger(os.Stdout, true)
	dialTimeout := os.Getenv("CF_DIAL_TIMEOUT")
	deps := initialiseDependency(socketWriter, traceLogger, dialTimeout, configRepo)
	defer deps.Config.Close()

	cfAppPush.pushCommand.SetDependency(deps, false)

	err = cfAppPush.flagContext.Parse("-p", clonePath, "-f", clonePath + "/manifest.yml")
	if err != nil {
		log.Warnf("Failed to parse due to: %+v", err)
		sendErrorMessage(clientWebSocket, err, CLOSE_FAILURE)
		return err
	}

	err = cfAppPush.pushCommand.Execute(cfAppPush.flagContext)
	if err != nil {
		log.Warnf("Failed to execute due to: %+v", err)
		sendErrorMessage(clientWebSocket, err, CLOSE_PUSH_ERROR)
		return err
	}

	closingMessage, _ := getMarshalledSocketMessage("", CLOSE_SUCCESS)
	clientWebSocket.WriteMessage(websocket.TextMessage, closingMessage)
	return nil
}

func getMarshalledSocketMessage(data string, messageType MessageType) ([]byte, error) {

	messageStruct := SocketMessage{
		Message:   string(data),
		Timestamp: time.Now().Unix(),
		Type:      messageType,
	}
	marshalledJson, err := json.Marshal(messageStruct)
	return marshalledJson, err

}

func initialiseDependency(writer io.Writer, logger trace.Printer, envDialTimeout string, config coreconfig.Repository) commandregistry.Dependency {

	deps := commandregistry.Dependency{}
	deps.TeePrinter = terminal.NewTeePrinter(writer)
	deps.UI = terminal.NewUI(os.Stdin, writer, deps.TeePrinter, logger)

	errorHandler := func(err error) {
		if err != nil {
			deps.UI.Failed(fmt.Sprintf("Config error: %s", err))
		}
	}

	deps.Config = config

	deps.ManifestRepo = manifest.NewDiskRepository()
	deps.AppManifest = manifest.NewGenerator()

	pluginPath := filepath.Join(confighelpers.PluginRepoDir(), ".cf", "plugins")
	deps.PluginConfig = pluginconfig.NewPluginConfig(
		errorHandler,
		configuration.NewDiskPersistor(filepath.Join(pluginPath, "config.json")),
		pluginPath,
	)

	terminal.UserAskedForColors = deps.Config.ColorEnabled()
	terminal.InitColorSupport()

	deps.Gateways = map[string]net.Gateway{
		"cloud-controller": net.NewCloudControllerGateway(deps.Config, time.Now, deps.UI, logger, envDialTimeout),
		"uaa":              net.NewUAAGateway(deps.Config, deps.UI, logger, envDialTimeout),
		"routing-api":      net.NewRoutingAPIGateway(deps.Config, time.Now, deps.UI, logger, envDialTimeout),
	}
	deps.RepoLocator = api.NewRepositoryLocator(deps.Config, deps.Gateways, logger, envDialTimeout)

	deps.PluginModels = &commandregistry.PluginModels{Application: nil}

	deps.PlanBuilder = planbuilder.NewBuilder(
		deps.RepoLocator.GetServicePlanRepository(),
		deps.RepoLocator.GetServicePlanVisibilityRepository(),
		deps.RepoLocator.GetOrganizationRepository(),
	)

	deps.ServiceBuilder = servicebuilder.NewBuilder(
		deps.RepoLocator.GetServiceRepository(),
		deps.PlanBuilder,
	)

	deps.BrokerBuilder = brokerbuilder.NewBuilder(
		deps.RepoLocator.GetServiceBrokerRepository(),
		deps.ServiceBuilder,
	)

	deps.PluginRepo = pluginrepo.NewPluginRepo()

	deps.ServiceHandler = actors.NewServiceHandler(
		deps.RepoLocator.GetOrganizationRepository(),
		deps.BrokerBuilder,
		deps.ServiceBuilder,
	)

	deps.ServicePlanHandler = actors.NewServicePlanHandler(
		deps.RepoLocator.GetServicePlanRepository(),
		deps.RepoLocator.GetServicePlanVisibilityRepository(),
		deps.RepoLocator.GetOrganizationRepository(),
		deps.PlanBuilder,
		deps.ServiceBuilder,
	)

	deps.WordGenerator = generator.NewWordGenerator()

	deps.AppZipper = appfiles.ApplicationZipper{}
	deps.AppFiles = appfiles.ApplicationFiles{}

	deps.RouteActor = actors.NewRouteActor(deps.UI, deps.RepoLocator.GetRouteRepository(), deps.RepoLocator.GetDomainRepository())
	deps.PushActor = actors.NewPushActor(deps.RepoLocator.GetApplicationBitsRepository(), deps.AppZipper, deps.AppFiles, deps.RouteActor)

	deps.ChecksumUtil = util.NewSha1Checksum("")

	deps.Logger = logger

	return deps

}
func (cfAppPush *CFAppPush) getConfigData(echoContext echo.Context, cnsiGuid string, orgGuid string, spaceGuid string, spaceName string, orgName string) (coreconfig.Repository, error) {

	var configRepo coreconfig.Repository
	cnsiRecord, err := cfAppPush.portalProxy.GetCNSIRecord(cnsiGuid)
	if err != nil {
		log.Warnf("Failed to retrieve record for CNSI %s, error is %+v", cnsiGuid, err)
		return configRepo, err
	}

	log.Infof("Found CNSI Record")

	userId, err := cfAppPush.portalProxy.GetSessionStringValue(echoContext, "user_id")

	if err != nil {
		log.Warnf("Failed to retrieve session user")
		return configRepo, err
	}
	log.Infof("Found User Session ID")

	log.Infof("User Info %+v", userId)
	cnsiTokenRecord, found := cfAppPush.portalProxy.GetCNSITokenRecord(cnsiGuid, userId)
	if !found {
		log.Warnf("Failed to retrieve record for CNSI %s", cnsiGuid)
		return configRepo, errors.New("Failed to find token record")
	}

	log.Infof("Found CNSI user token info")

	var filePath = fmt.Sprintf("/tmp/%s", uuid.NewV1())
	repo := coreconfig.NewRepositoryFromFilepath(filePath, func(error) {})

	repo.SetAuthenticationEndpoint(cnsiRecord.AuthorizationEndpoint)
	repo.SetAPIEndpoint(cnsiRecord.APIEndpoint.String())
	repo.SetDopplerEndpoint(cnsiRecord.DopplerLoggingEndpoint)
	repo.SetSSLDisabled(cnsiRecord.SkipSSLValidation)
	repo.SetAccessToken(cnsiTokenRecord.AuthToken)
	repo.SetRefreshToken(cnsiTokenRecord.RefreshToken)
	repo.SetColorEnabled("true")
	repo.SetOrganizationFields(models.OrganizationFields{
		GUID: orgGuid,
		Name: orgName,
	})
	repo.SetSpaceFields(models.SpaceFields{
		GUID: spaceGuid,
		Name: spaceName,
	})

	return repo, nil
}

func cloneRepository(repoUrl string, branch string) (string, string, error) {

	dir, err := ioutil.TempDir("", "git-clone-")
	fmt.Printf("Directory is: %s", dir)

	if err != nil {
		return "", "", err
	}
	repo, err := git.PlainClone(dir, false, &git.CloneOptions{
		URL:               repoUrl,
		RecurseSubmodules: git.DefaultSubmoduleRecursionDepth,
	})

	if err != nil {
		log.Infof("Failed to clone repo %s due to %+v", repoUrl, err)
		return "", "", err
	}

	branchRef := fmt.Sprintf("refs/remotes/origin/%s", branch)
	log.Infof("Will checkout branch %s", branchRef)
	if branchRef != "" {
		workTree, err := repo.Worktree()
		checkoutOpts := &git.CheckoutOptions{
			Branch: plumbing.ReferenceName(branchRef),
		}
		err = workTree.Checkout(checkoutOpts)
		if err != nil {
			log.Infof("Failed to checkout %s branch in repo %s, %s due to %+v", branch, repoUrl, branchRef, err)
			return "", "", err
		}
	}

	head, err := repo.Head()
	if err != nil {
		log.Infof("Unable to fetch HEAD in branch due to %s", err)
		return "", "", err
	}

	return dir, head.Hash().String(), nil
}

// This assumes manifest lives in the root of the app
func fetchManifest(repoPath string, projectUrl string, commitHash string, branch string) (manifest.Applications, error) {

	var manifest manifest.Applications
	manifestPath := fmt.Sprintf("%s/manifest.yml", repoPath)
	data, err := ioutil.ReadFile(manifestPath)
	if err != nil {
		log.Warnf("Failed to read manifest in path %s", manifestPath)
		return manifest, err
	}

	err = yaml.Unmarshal(data, &manifest)
	if err != nil {
		log.Warnf("Failed to unmarshall manifest in path %s", manifestPath)
		return manifest, err
	}

	for i, app := range manifest.Applications {
		if len(app.Env) == 0 {
			app.Env = make(map[string]interface{})
		}

		stratosProject := StratosProject{
			Url: projectUrl,
			CommitHash: commitHash,
			Branch: branch,
			Timestamp: time.Now().Unix(),
		}

		marshalledJson, _ := json.Marshal(stratosProject)
		app.Env[stratosProjectKey] = string(marshalledJson)
		manifest.Applications[i] = app
	}

	marshalledYaml, err := yaml.Marshal(manifest)
	if err != nil {
		log.Warnf("Failed to marshall manifest in path %v", manifest)
		return manifest, err
	}
	ioutil.WriteFile(manifestPath, marshalledYaml, 0600)

	return manifest, nil
}

type SocketMessage struct {
	Message   string      `json:"message"`
	Timestamp int64       `json:"timestamp"`
	Type      MessageType `json:"type"`
}

func (sw *SocketWriter) Write(data []byte) (int, error) {

	message, _ := getMarshalledSocketMessage(string(data), DATA)

	err := sw.clientWebSocket.WriteMessage(websocket.TextMessage, message)
	if err != nil {
		return 0, err
	}
	return len(data), nil
}

func sendManifest(manifest manifest.Applications, clientWebSocket *websocket.Conn) error {

	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	manifestJson := string(manifestBytes)
	log.Infof("Fetched Manifest: %s", manifestJson)

	message, _ := getMarshalledSocketMessage(manifestJson, MANIFEST)

	clientWebSocket.WriteMessage(websocket.TextMessage, message)
	return nil
}

func sendErrorMessage(clientWebSocket *websocket.Conn, err error, errorType MessageType) {
	closingMessage, _ := getMarshalledSocketMessage(fmt.Sprintf("Failed due to %s!", err), errorType)
	clientWebSocket.WriteMessage(websocket.TextMessage, closingMessage)
}
